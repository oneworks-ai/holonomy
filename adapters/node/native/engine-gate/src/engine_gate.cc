#include <node.h>
#include <v8.h>

#include <cerrno>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <poll.h>
#include <string>
#include <string_view>
#include <unistd.h>
#include <vector>

namespace holonomy_engine_gate {

using v8::Context;
using v8::ArrayBuffer;
using v8::ArrayBufferView;
using v8::FunctionCallbackInfo;
using v8::Isolate;
using v8::Local;
using v8::MaybeLocal;
using v8::ModifyCodeGenerationFromStringsResult;
using v8::Object;
using v8::String;
using v8::Value;

enum class Decision : uint8_t { kDeny, kAllow, kHost };

struct GateLimits {
  int timeout_ms = 1;
  uint64_t max_operations = 1;
  uint64_t max_source_bytes = 1;
};

struct ContextGate {
  uint32_t id = 0;
  Decision strings = Decision::kDeny;
  Decision wasm = Decision::kDeny;
  GateLimits strings_limits;
  GateLimits wasm_limits;
  int request_fd = -1;
  int response_fd = -1;
  uint64_t strings_callbacks = 0;
  uint64_t wasm_callbacks = 0;
  bool has_staged_wasm_source = false;
  std::vector<uint8_t> staged_wasm_source;
};

struct IsolateGate {
  Isolate* isolate = nullptr;
  bool installed = false;
  v8::Global<Context> host_context;
  bool has_staged_host_wasm_source = false;
  std::vector<uint8_t> staged_host_wasm_source;
  uint64_t next_request_id = 0;
  std::vector<std::unique_ptr<ContextGate>> contexts;
};

IsolateGate state;

void CleanupHostContext(void*) {
  state.host_context.Reset();
  state.has_staged_host_wasm_source = false;
  state.staged_host_wasm_source.clear();
  state.isolate = nullptr;
  state.installed = false;
}

void ThrowTypeError(Isolate* isolate, const char* message) {
  isolate->ThrowException(v8::Exception::TypeError(
      String::NewFromUtf8(isolate, message).ToLocalChecked()));
}

ContextGate* FindId(uint32_t id);

ContextGate* FindContext(Local<Context> context) {
  Local<Value> value;
  if (!context->Global()
           ->Get(context,
                 String::NewFromUtf8Literal(
                     state.isolate, "__holonomyEngineGateContextId"))
           .ToLocal(&value) ||
      !value->IsUint32()) return nullptr;
  return FindId(value.As<v8::Uint32>()->Value());
}

ContextGate* FindId(uint32_t id) {
  for (const auto& item : state.contexts) {
    if (item->id == id) return item.get();
  }
  return nullptr;
}

bool ReadDecision(Isolate* isolate, Local<Object> options, const char* key,
                  Decision* output) {
  Local<Context> context = isolate->GetCurrentContext();
  Local<Value> value;
  if (!options
           ->Get(context, String::NewFromUtf8(isolate, key).ToLocalChecked())
           .ToLocal(&value) ||
      !value->IsString()) {
    ThrowTypeError(isolate, "Engine Gate decision is invalid");
    return false;
  }
  String::Utf8Value text(isolate, value);
  std::string_view decision(*text == nullptr ? "" : *text, text.length());
  if (decision == "allow") *output = Decision::kAllow;
  else if (decision == "deny") *output = Decision::kDeny;
  else if (decision == "host") *output = Decision::kHost;
  else {
    ThrowTypeError(isolate, "Engine Gate decision is invalid");
    return false;
  }
  return true;
}

bool ReadInteger(Isolate* isolate, Local<Object> options, const char* key,
                 uint64_t minimum, uint64_t maximum, uint64_t* output) {
  Local<Context> context = isolate->GetCurrentContext();
  Local<Value> value;
  if (!options
           ->Get(context, String::NewFromUtf8(isolate, key).ToLocalChecked())
           .ToLocal(&value) ||
      !value->IsUint32()) {
    ThrowTypeError(isolate, "Engine Gate limit must be an integer");
    return false;
  }
  uint64_t integer = value.As<v8::Uint32>()->Value();
  if (integer < minimum || integer > maximum) {
    ThrowTypeError(isolate, "Engine Gate limit is outside the supported range");
    return false;
  }
  *output = integer;
  return true;
}

bool WriteAll(int fd, const char* data, size_t length) {
  while (length > 0) {
    ssize_t written = write(fd, data, length);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) return false;
    data += written;
    length -= static_cast<size_t>(written);
  }
  return true;
}

bool AwaitHostDecision(ContextGate& gate, char kind, bool is_code_like,
                       const std::vector<uint8_t>& source,
                       const GateLimits& limits) {
  if (gate.request_fd < 0 || gate.response_fd < 0) return false;
  const uint64_t request_id = ++state.next_request_id;
  char request[160];
  int length = std::snprintf(
      request, sizeof(request), "HGE2 %llu %c %d %llu\n",
      static_cast<unsigned long long>(request_id), kind,
      is_code_like ? 1 : 0,
      static_cast<unsigned long long>(source.size()));
  if (length <= 0 || static_cast<size_t>(length) >= sizeof(request) ||
      !WriteAll(gate.request_fd, request, static_cast<size_t>(length))) {
    return false;
  }
  if (!source.empty() &&
      !WriteAll(gate.request_fd,
                reinterpret_cast<const char*>(source.data()), source.size())) {
    return false;
  }
  const auto deadline = std::chrono::steady_clock::now() +
                        std::chrono::milliseconds(limits.timeout_ms);
  for (uint64_t ignored = 0; ignored < 64; ++ignored) {
    const auto now = std::chrono::steady_clock::now();
    if (now >= deadline) return false;
    const auto remaining =
        std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now)
            .count();
    const int poll_timeout = static_cast<int>(remaining > 0 ? remaining : 1);
    pollfd descriptor = {gate.response_fd, POLLIN, 0};
    int ready;
    do {
      ready = poll(&descriptor, 1, poll_timeout);
    } while (ready < 0 && errno == EINTR);
    if (ready <= 0 || (descriptor.revents & POLLIN) == 0) return false;
    char response[96];
    size_t position = 0;
    while (position + 1 < sizeof(response)) {
      char byte;
      ssize_t count = read(gate.response_fd, &byte, 1);
      if (count < 0 && errno == EINTR) continue;
      if (count != 1) return false;
      if (byte == '\n') break;
      response[position++] = byte;
    }
    response[position] = '\0';
    unsigned long long response_id = 0;
    char decision[16] = {};
    if (std::sscanf(response, "HGE1 %llu %15s", &response_id, decision) != 2 ||
        response_id != request_id) {
      continue;
    }
    return std::strcmp(decision, "allow") == 0;
  }
  return false;
}

bool Decide(ContextGate& gate, Decision decision, char kind,
            bool is_code_like, const std::vector<uint8_t>& source,
            uint64_t count,
            const GateLimits& limits) {
  if (count > limits.max_operations ||
      source.size() > limits.max_source_bytes ||
      decision == Decision::kDeny) {
    return false;
  }
  if (decision == Decision::kAllow) return true;
  return AwaitHostDecision(gate, kind, is_code_like, source, limits);
}

ModifyCodeGenerationFromStringsResult StringsGate(Local<Context> context,
                                                   Local<Value> source,
                                                   bool is_code_like) {
  ContextGate* gate = FindContext(context);
  if (gate == nullptr) return {false, MaybeLocal<String>()};
  ++gate->strings_callbacks;
  if (!source->IsString()) return {false, MaybeLocal<String>()};
  Local<String> text = source.As<String>();
  const int source_bytes = text->Utf8Length(state.isolate);
  if (source_bytes < 0 ||
      static_cast<uint64_t>(source_bytes) > gate->strings_limits.max_source_bytes) {
    return {false, MaybeLocal<String>()};
  }
  std::vector<uint8_t> copied(static_cast<size_t>(source_bytes));
  if (source_bytes > 0) {
    const int written = text->WriteUtf8(
        state.isolate, reinterpret_cast<char*>(copied.data()), source_bytes,
        nullptr, String::NO_NULL_TERMINATION | String::REPLACE_INVALID_UTF8);
    if (written != source_bytes) return {false, MaybeLocal<String>()};
  }
  return {Decide(*gate, gate->strings, 'S', is_code_like, copied,
                 gate->strings_callbacks, gate->strings_limits),
          MaybeLocal<String>()};
}

bool IsHostContext(Local<Context> context) {
  if (state.host_context.IsEmpty()) return false;
  return state.host_context.Get(state.isolate) == context;
}

bool IsHostCall(Isolate* isolate) {
  return IsHostContext(isolate->GetCurrentContext()) &&
         IsHostContext(isolate->GetEnteredOrMicrotaskContext());
}

bool WasmGate(Local<Context> context, Local<String>) {
  // The trusted Node Host realm can compile only while its own one-shot
  // verified source is staged. A Guest Context cannot consume this permit.
  if (IsHostContext(context)) {
    if (!IsHostCall(state.isolate) || !state.has_staged_host_wasm_source) return false;
    state.has_staged_host_wasm_source = false;
    state.staged_host_wasm_source.clear();
    return true;
  }
  ContextGate* gate = FindContext(context);
  if (gate == nullptr) return false;
  ++gate->wasm_callbacks;
  if (!gate->has_staged_wasm_source) return false;
  gate->has_staged_wasm_source = false;
  std::vector<uint8_t> source = std::move(gate->staged_wasm_source);
  gate->staged_wasm_source.clear();
  return Decide(*gate, gate->wasm, 'W', false, source,
                gate->wasm_callbacks, gate->wasm_limits);
}

bool CopyBufferSource(Isolate* isolate, Local<Value> value,
                      std::vector<uint8_t>* output) {
  if (value->IsSharedArrayBuffer()) return false;
  if (value->IsArrayBuffer()) {
    Local<ArrayBuffer> buffer = value.As<ArrayBuffer>();
    std::shared_ptr<v8::BackingStore> backing = buffer->GetBackingStore();
    if (buffer->WasDetached() || backing->IsShared() ||
        backing->IsResizableByUserJavaScript()) return false;
    output->resize(backing->ByteLength());
    if (!output->empty()) std::memcpy(output->data(), backing->Data(), output->size());
    return true;
  }
  if (!value->IsArrayBufferView()) return false;
  Local<ArrayBufferView> view = value.As<ArrayBufferView>();
  Local<ArrayBuffer> buffer = view->Buffer();
  std::shared_ptr<v8::BackingStore> backing = buffer->GetBackingStore();
  if (buffer->WasDetached() || backing->IsShared() ||
      backing->IsResizableByUserJavaScript()) return false;
  output->resize(view->ByteLength());
  return output->empty() || view->CopyContents(output->data(), output->size()) == output->size();
}

void StageWasmSource(const FunctionCallbackInfo<Value>& args) {
  Isolate* isolate = args.GetIsolate();
  if (args.Length() != 2 || !args[0]->IsUint32()) {
    return ThrowTypeError(isolate, "Invalid staged Wasm source");
  }
  ContextGate* gate = FindId(args[0].As<v8::Uint32>()->Value());
  if (gate == nullptr) return ThrowTypeError(isolate, "Unknown Engine Gate context");
  std::vector<uint8_t> source;
  if (!CopyBufferSource(isolate, args[1], &source)) {
    return ThrowTypeError(isolate, "Invalid staged Wasm BufferSource");
  }
  gate->has_staged_wasm_source = true;
  gate->staged_wasm_source = std::move(source);
}

void StageHostWasmSource(const FunctionCallbackInfo<Value>& args) {
  Isolate* isolate = args.GetIsolate();
  if (!state.installed || state.isolate != isolate ||
      !IsHostCall(isolate) || args.Length() != 1) {
    return ThrowTypeError(isolate, "Invalid Host Wasm staging context");
  }
  std::vector<uint8_t> source;
  if (!CopyBufferSource(isolate, args[0], &source) ||
      source.empty() || source.size() > 16 * 1024 * 1024) {
    return ThrowTypeError(isolate, "Invalid Host Wasm BufferSource");
  }
  state.staged_host_wasm_source = std::move(source);
  state.has_staged_host_wasm_source = true;
}

void ClearHostWasmSource(const FunctionCallbackInfo<Value>& args) {
  Isolate* isolate = args.GetIsolate();
  if (!state.installed || state.isolate != isolate ||
      !IsHostCall(isolate)) {
    return ThrowTypeError(isolate, "Invalid Host Wasm staging context");
  }
  state.has_staged_host_wasm_source = false;
  state.staged_host_wasm_source.clear();
}

void IsInstalled(const FunctionCallbackInfo<Value>& args) {
  Isolate* isolate = args.GetIsolate();
  args.GetReturnValue().Set(v8::Boolean::New(
      isolate, state.installed && state.isolate == isolate));
}

void RequestWasm(const FunctionCallbackInfo<Value>& args) {
  Isolate* isolate = args.GetIsolate();
  if (args.Length() != 2 || !args[0]->IsUint32()) {
    return ThrowTypeError(isolate, "Invalid Wasm Engine Gate request");
  }
  ContextGate* gate = FindId(args[0].As<v8::Uint32>()->Value());
  if (gate == nullptr) return ThrowTypeError(isolate, "Unknown Engine Gate context");
  std::vector<uint8_t> source;
  if (!CopyBufferSource(isolate, args[1], &source)) {
    return ThrowTypeError(isolate, "Invalid Wasm Engine Gate BufferSource");
  }
  ++gate->wasm_callbacks;
  args.GetReturnValue().Set(v8::Boolean::New(
      isolate, Decide(*gate, gate->wasm, 'W', false, source,
                      gate->wasm_callbacks, gate->wasm_limits)));
}

void Configure(const FunctionCallbackInfo<Value>& args) {
  Isolate* isolate = args.GetIsolate();
  if (args.Length() != 1 || !args[0]->IsObject()) {
    ThrowTypeError(isolate, "Engine Gate configuration must be an object");
    return;
  }
  if (state.installed && state.isolate != isolate) {
    ThrowTypeError(isolate, "Engine Gate is already bound to another isolate");
    return;
  }
  Local<Object> options = args[0].As<Object>();
  Decision strings;
  Decision wasm;
  uint64_t request_fd;
  uint64_t response_fd;
  uint64_t context_id;
  uint64_t strings_timeout_ms;
  uint64_t strings_max_operations;
  uint64_t strings_max_source_bytes;
  uint64_t wasm_timeout_ms;
  uint64_t wasm_max_operations;
  uint64_t wasm_max_source_bytes;
  if (!ReadDecision(isolate, options, "strings", &strings) ||
      !ReadDecision(isolate, options, "wasm", &wasm) ||
      !ReadInteger(isolate, options, "contextId", 1, 0xFFFFFFFFu, &context_id) ||
      !ReadInteger(isolate, options, "requestFd", 0, 1024, &request_fd) ||
      !ReadInteger(isolate, options, "responseFd", 0, 1024, &response_fd) ||
      !ReadInteger(isolate, options, "stringsTimeoutMs", 1, 120000,
                   &strings_timeout_ms) ||
      !ReadInteger(isolate, options, "stringsMaxOperations", 1, 100000,
                   &strings_max_operations) ||
      !ReadInteger(isolate, options, "stringsMaxSourceBytes", 1,
                   16 * 1024 * 1024, &strings_max_source_bytes) ||
      !ReadInteger(isolate, options, "wasmTimeoutMs", 1, 120000,
                   &wasm_timeout_ms) ||
      !ReadInteger(isolate, options, "wasmMaxOperations", 1, 100000,
                   &wasm_max_operations) ||
      !ReadInteger(isolate, options, "wasmMaxSourceBytes", 1,
                   16 * 1024 * 1024, &wasm_max_source_bytes)) {
    return;
  }
  ContextGate* gate = FindId(static_cast<uint32_t>(context_id));
  if (gate == nullptr) {
    if (state.contexts.size() >= 16) {
      ThrowTypeError(isolate, "Engine Gate context limit exceeded");
      return;
    }
    auto item = std::make_unique<ContextGate>();
    item->id = static_cast<uint32_t>(context_id);
    gate = item.get();
    state.contexts.push_back(std::move(item));
  }
  gate->strings = strings;
  gate->wasm = wasm;
  gate->request_fd = static_cast<int>(request_fd);
  gate->response_fd = static_cast<int>(response_fd);
  gate->strings_limits = {static_cast<int>(strings_timeout_ms),
                          strings_max_operations, strings_max_source_bytes};
  gate->wasm_limits = {static_cast<int>(wasm_timeout_ms), wasm_max_operations,
                       wasm_max_source_bytes};
  gate->strings_callbacks = 0;
  gate->wasm_callbacks = 0;
  gate->has_staged_wasm_source = false;
  gate->staged_wasm_source.clear();
  state.isolate = isolate;
  if (!state.installed) {
    state.host_context.Reset(isolate, isolate->GetCurrentContext());
    node::AddEnvironmentCleanupHook(isolate, CleanupHostContext, nullptr);
    isolate->SetModifyCodeGenerationFromStringsCallback(StringsGate);
    isolate->SetAllowWasmCodeGenerationCallback(WasmGate);
    state.installed = true;
  }
  args.GetReturnValue().Set(gate->id);
}

ContextGate* ReadGateId(const FunctionCallbackInfo<Value>& args) {
  if (args.Length() != 1 || !args[0]->IsUint32()) return nullptr;
  return FindId(args[0].As<v8::Uint32>()->Value());
}

void ResetCounts(const FunctionCallbackInfo<Value>& args) {
  ContextGate* gate = ReadGateId(args);
  if (gate == nullptr) return ThrowTypeError(args.GetIsolate(), "Unknown Engine Gate context");
  gate->strings_callbacks = 0;
  gate->wasm_callbacks = 0;
}

void Snapshot(const FunctionCallbackInfo<Value>& args) {
  Isolate* isolate = args.GetIsolate();
  ContextGate* gate = ReadGateId(args);
  if (gate == nullptr) return ThrowTypeError(isolate, "Unknown Engine Gate context");
  Local<Context> context = isolate->GetCurrentContext();
  Local<Object> output = Object::New(isolate);
  output->Set(context, String::NewFromUtf8Literal(isolate, "installed"),
              v8::Boolean::New(isolate, state.installed)).Check();
  output->Set(context, String::NewFromUtf8Literal(isolate, "stringsCallbacks"),
              v8::Number::New(isolate, gate->strings_callbacks)).Check();
  output->Set(context, String::NewFromUtf8Literal(isolate, "wasmCallbacks"),
              v8::Number::New(isolate, gate->wasm_callbacks)).Check();
  args.GetReturnValue().Set(output);
}

void Initialize(Local<Object> exports, Local<Value>, void*) {
  NODE_SET_METHOD(exports, "configure", Configure);
  NODE_SET_METHOD(exports, "clearHostWasmSource", ClearHostWasmSource);
  NODE_SET_METHOD(exports, "isInstalled", IsInstalled);
  NODE_SET_METHOD(exports, "resetCounts", ResetCounts);
  NODE_SET_METHOD(exports, "requestWasm", RequestWasm);
  NODE_SET_METHOD(exports, "snapshot", Snapshot);
  NODE_SET_METHOD(exports, "stageHostWasmSource", StageHostWasmSource);
  NODE_SET_METHOD(exports, "stageWasmSource", StageWasmSource);
}

NODE_MODULE(NODE_GYP_MODULE_NAME, Initialize)

}  // namespace holonomy_engine_gate
