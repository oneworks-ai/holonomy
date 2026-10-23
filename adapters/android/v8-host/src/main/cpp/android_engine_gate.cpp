#include <jni.h>

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <dlfcn.h>
#include <memory>
#include <vector>

namespace {

constexpr jint kStringsKind = 1;
constexpr jint kWasmKind = 2;
constexpr std::size_t kMaxSourceBytes = 16U * 1024U * 1024U;
constexpr int kNoNullTermination = 2;
constexpr const char* kJavetLibrary = "libjavet-v8-android.v.5.0.10.so";

struct LocalHandle {
    void* value;
};

struct MaybeLocalString {
    void* value;
};

struct ModifyCodeGenerationResult {
    bool codegenAllowed;
    MaybeLocalString modifiedSource;
};

static_assert(sizeof(void*) == 8, "Holonomy Android Engine Gate supports 64-bit ABIs only");
static_assert(offsetof(ModifyCodeGenerationResult, modifiedSource) == 8);
static_assert(sizeof(ModifyCodeGenerationResult) == 16);

using ModifyCodeGenerationCallback = ModifyCodeGenerationResult (*)(LocalHandle, LocalHandle, bool);
using AllowWasmCodeGenerationCallback = bool (*)(LocalHandle, LocalHandle);
using SetModifyCodeGenerationCallback = void (*)(void*, ModifyCodeGenerationCallback);
using SetAllowWasmCodeGenerationCallback = void (*)(void*, AllowWasmCodeGenerationCallback);
using GetCurrentIsolate = void* (*)();
using FullIsString = bool (*)(void*);
using Utf8Length = std::size_t (*)(void*, void*);
using WriteUtf8 = std::size_t (*)(void*, void*, char*, std::size_t, int, std::size_t*);

struct Binding {
    JavaVM* vm = nullptr;
    jobject owner = nullptr;
    jmethodID decide = nullptr;
    void* library = nullptr;
    void* isolate = nullptr;
    SetModifyCodeGenerationCallback setStrings = nullptr;
    SetAllowWasmCodeGenerationCallback setWasm = nullptr;
    GetCurrentIsolate getCurrentIsolate = nullptr;
    FullIsString fullIsString = nullptr;
    Utf8Length utf8Length = nullptr;
    WriteUtf8 writeUtf8 = nullptr;
    std::atomic<bool> active{true};
};

thread_local Binding* currentBinding = nullptr;
thread_local bool deciding = false;

template <typename T>
T loadSymbol(void* library, const char* name) {
    return reinterpret_cast<T>(dlsym(library, name));
}

void throwIllegalState(JNIEnv* env, const char* message) {
    jclass type = env->FindClass("java/lang/IllegalStateException");
    if (type != nullptr) {
        env->ThrowNew(type, message);
        env->DeleteLocalRef(type);
    }
}

bool copySource(Binding* binding, LocalHandle source, std::vector<std::uint8_t>* output) {
    if (source.value == nullptr || !binding->fullIsString(source.value)) return false;
    const std::size_t length = binding->utf8Length(source.value, binding->isolate);
    if (length > kMaxSourceBytes) return false;
    output->resize(length);
    if (length == 0) return true;
    const std::size_t written = binding->writeUtf8(
        source.value,
        binding->isolate,
        reinterpret_cast<char*>(output->data()),
        length,
        kNoNullTermination,
        nullptr);
    return written == length;
}

bool decide(jint kind, LocalHandle source, bool isCodeLike) {
    Binding* binding = currentBinding;
    if (binding == nullptr || !binding->active.load(std::memory_order_acquire) || deciding) return false;
    std::vector<std::uint8_t> bytes;
    if (!copySource(binding, source, &bytes)) return false;
    JNIEnv* env = nullptr;
    if (binding->vm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6) != JNI_OK || env == nullptr) {
        return false;
    }
    deciding = true;
    jbyteArray sourceBytes = env->NewByteArray(static_cast<jsize>(bytes.size()));
    if (sourceBytes == nullptr) {
        if (env->ExceptionCheck()) env->ExceptionClear();
        deciding = false;
        return false;
    }
    if (!bytes.empty()) {
        env->SetByteArrayRegion(
            sourceBytes,
            0,
            static_cast<jsize>(bytes.size()),
            reinterpret_cast<const jbyte*>(bytes.data()));
    }
    const jboolean allowed = env->CallBooleanMethod(
        binding->owner,
        binding->decide,
        kind,
        sourceBytes,
        static_cast<jboolean>(isCodeLike));
    env->DeleteLocalRef(sourceBytes);
    const bool failed = env->ExceptionCheck();
    if (failed) env->ExceptionClear();
    deciding = false;
    return !failed && allowed == JNI_TRUE;
}

ModifyCodeGenerationResult onStrings(LocalHandle, LocalHandle source, bool isCodeLike) {
    return ModifyCodeGenerationResult{decide(kStringsKind, source, isCodeLike), {nullptr}};
}

bool onWasm(LocalHandle, LocalHandle source) {
    return decide(kWasmKind, source, false);
}

void destroyBinding(JNIEnv* env, Binding* binding) {
    if (binding == nullptr) return;
    binding->active.store(false, std::memory_order_release);
    if (currentBinding == binding) {
        binding->setStrings(binding->isolate, nullptr);
        binding->setWasm(binding->isolate, nullptr);
        currentBinding = nullptr;
    }
    if (binding->owner != nullptr) env->DeleteGlobalRef(binding->owner);
    if (binding->library != nullptr) dlclose(binding->library);
    delete binding;
}

}  // namespace

extern "C" JNIEXPORT jlong JNICALL
Java_ai_oneworks_holonomy_v8_AndroidEngineGateNativeBinding_nativeInstall(
    JNIEnv* env,
    jobject owner) {
    if (currentBinding != nullptr) {
        throwIllegalState(env, "The Android Engine Gate binding is invalid");
        return 0;
    }
    auto binding = std::make_unique<Binding>();
    binding->library = dlopen(kJavetLibrary, RTLD_NOW | RTLD_NOLOAD);
    if (binding->library == nullptr) binding->library = dlopen(kJavetLibrary, RTLD_NOW);
    if (binding->library == nullptr) {
        throwIllegalState(env, "The pinned Javet native library is unavailable");
        return 0;
    }
    binding->setStrings = loadSymbol<SetModifyCodeGenerationCallback>(
        binding->library,
        "_ZN2v87Isolate42SetModifyCodeGenerationFromStringsCallbackEPFNS_37ModifyCodeGenerationFromStringsResultENS_5LocalINS_7ContextEEENS2_INS_5ValueEEEbE");
    binding->setWasm = loadSymbol<SetAllowWasmCodeGenerationCallback>(
        binding->library,
        "_ZN2v87Isolate34SetAllowWasmCodeGenerationCallbackEPFbNS_5LocalINS_7ContextEEENS1_INS_6StringEEEE");
    binding->getCurrentIsolate = loadSymbol<GetCurrentIsolate>(
        binding->library,
        "_ZN2v87Isolate10GetCurrentEv");
    binding->fullIsString = loadSymbol<FullIsString>(binding->library, "_ZNK2v85Value12FullIsStringEv");
    binding->utf8Length = loadSymbol<Utf8Length>(binding->library, "_ZNK2v86String10Utf8LengthEPNS_7IsolateE");
    binding->writeUtf8 = loadSymbol<WriteUtf8>(binding->library, "_ZNK2v86String9WriteUtf8EPNS_7IsolateEPcmiPm");
    if (
        binding->setStrings == nullptr || binding->setWasm == nullptr || binding->getCurrentIsolate == nullptr ||
        binding->fullIsString == nullptr || binding->utf8Length == nullptr || binding->writeUtf8 == nullptr) {
        destroyBinding(env, binding.release());
        throwIllegalState(env, "The pinned Javet V8 ABI does not expose the required Engine Gate symbols");
        return 0;
    }
    if (env->GetJavaVM(&binding->vm) != JNI_OK) {
        destroyBinding(env, binding.release());
        throwIllegalState(env, "The pinned Javet Runtime handle is invalid");
        return 0;
    }
    jclass ownerClass = env->GetObjectClass(owner);
    binding->decide = ownerClass == nullptr
        ? nullptr
        : env->GetMethodID(ownerClass, "decideNative", "(I[BZ)Z");
    if (ownerClass != nullptr) env->DeleteLocalRef(ownerClass);
    binding->owner = env->NewGlobalRef(owner);
    if (binding->decide == nullptr || binding->owner == nullptr) {
        if (env->ExceptionCheck()) env->ExceptionClear();
        destroyBinding(env, binding.release());
        throwIllegalState(env, "The Android Engine Gate callback is unavailable");
        return 0;
    }
    return reinterpret_cast<jlong>(binding.release());
}

extern "C" JNIEXPORT jboolean JNICALL
Java_ai_oneworks_holonomy_v8_AndroidEngineGateNativeBinding_nativeArm(
    JNIEnv*,
    jobject,
    jlong bindingHandle) {
    auto* binding = reinterpret_cast<Binding*>(bindingHandle);
    if (binding == nullptr || !binding->active.load(std::memory_order_acquire)) return JNI_FALSE;
    if (currentBinding == binding && binding->isolate != nullptr) return JNI_TRUE;
    if (currentBinding != nullptr) return JNI_FALSE;
    binding->isolate = binding->getCurrentIsolate();
    if (binding->isolate == nullptr) return JNI_FALSE;
    currentBinding = binding;
    binding->setStrings(binding->isolate, onStrings);
    binding->setWasm(binding->isolate, onWasm);
    return JNI_TRUE;
}

extern "C" JNIEXPORT void JNICALL
Java_ai_oneworks_holonomy_v8_AndroidEngineGateNativeBinding_nativeUninstall(
    JNIEnv* env,
    jobject,
    jlong bindingHandle) {
    destroyBinding(env, reinterpret_cast<Binding*>(bindingHandle));
}
