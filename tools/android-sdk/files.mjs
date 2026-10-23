export const SDK_MODULES = Object.freeze([
  'host-core',
  'v8-host',
  'runtime-host',
  'crypto-host',
  'storage-host',
  'capability-host',
  'network-host',
  'session-host'
])

const consumer = 'adapters/android/sdk/consumer'
export const SDK_SOURCE_FILES = Object.freeze({
  'LICENSE': 'LICENSE',
  'consumer/settings.gradle.kts': `${consumer}/settings.gradle.kts`,
  'consumer/build.gradle.kts': `${consumer}/build.gradle.kts`,
  'consumer/gradle.properties': `${consumer}/gradle.properties`,
  'consumer/app/build.gradle.kts': `${consumer}/app/build.gradle.kts`,
  'consumer/app/src/main/AndroidManifest.xml': `${consumer}/app/src/main/AndroidManifest.xml`,
  'consumer/app/src/androidTest/kotlin/ai/oneworks/holonomy/sdk/consumer/EmbeddedRuntimeTest.kt':
    `${consumer}/app/src/androidTest/kotlin/ai/oneworks/holonomy/sdk/consumer/EmbeddedRuntimeTest.kt`,
  'consumer/app/src/androidTest/assets/crypto-v1.test.mjs': 'conformance/capabilities/crypto-v1.test.mjs',
  'consumer/gradlew': 'adapters/android/gradlew',
  'consumer/gradlew.bat': 'adapters/android/gradlew.bat',
  'consumer/gradle/wrapper/gradle-wrapper.jar': 'adapters/android/gradle/wrapper/gradle-wrapper.jar',
  'consumer/gradle/wrapper/gradle-wrapper.properties': 'adapters/android/gradle/wrapper/gradle-wrapper.properties',
  ...Object.fromEntries(
    ['runtime-host', 'crypto-host', 'storage-host', 'network-host', 'session-host'].flatMap(module =>
      ['README.md', 'README.zh-Hans.md'].map(file => [`guides/${module}/${file}`, `adapters/android/${module}/${file}`])
    )
  )
})

export const sdkLibraryPath = module => `consumer/libraries/${module}-debug.aar`
export const SDK_PAYLOAD_PATHS = Object.freeze([
  ...Object.keys(SDK_SOURCE_FILES),
  ...SDK_MODULES.map(sdkLibraryPath),
  'README.md',
  'README.zh-Hans.md'
].sort())

export const sdkReadme = chinese =>
  (chinese
    ? [
      '# Holonomy Android 开发 SDK',
      '',
      '[English](README.md)',
      '',
      '这是本地开发 AAR 交付，不是 Maven 发布、fat AAR、产品 APK 或真机验收。',
      '包含八个显式模块；不附带 Javet、Linux 镜像、E2E 应用或任何默认权限。',
      '要求 API29+、JDK17、SDK35。另需 Javet5.0.10、Kotlin2.0.21；可选 Session 依赖 Gson2.10.1。',
      '',
      'consumer 是独立 Gradle App，只使用四个 core/Crypto AAR 和 Javet，不依赖 E2E 工程。',
      '先读 [Runtime 接入](guides/runtime-host/README.zh-Hans.md)。在已授权设备上运行：',
      '',
      '    ./consumer/gradlew -p consumer :app:connectedDebugAndroidTest',
      '',
      '共享 JavaScript node:test 拥有断言，Kotlin 只装配引擎并校验终态。',
      '这不代表八个可选模块均独立验收；打包命令不会自动运行设备测试。',
      'manifest.json 记录逐文件大小和 SHA256；外层 verification.json 是最后发布的完成标记。',
      '不声明签名、真机、完整再分发许可或生产发布。',
      ''
    ]
    : [
      '# Holonomy Android development SDK',
      '',
      '[简体中文](README.zh-Hans.md)',
      '',
      'This local development AAR bundle is not a Maven release, fat AAR, product APK or physical-device acceptance.',
      'It contains eight explicitly selected modules, not Javet, Linux images, the E2E application or ambient authority.',
      'Requires API29+, JDK17 and SDK35. Resolve Javet5.0.10 and Kotlin2.0.21 separately; optional Session needs Gson2.10.1.',
      '',
      'consumer is an independent Gradle App using only four core/Crypto AARs plus Javet, with no E2E project dependency.',
      'Read the [Runtime guide](guides/runtime-host/README.md). With an already-authorized device:',
      '',
      '    ./consumer/gradlew -p consumer :app:connectedDebugAndroidTest',
      '',
      'The shared JavaScript node:test workload owns assertions; Kotlin composes the engine and checks its terminal.',
      'This does not verify all eight optional modules. Packaging checks bytes and inventory, not device execution.',
      'manifest.json records exact file sizes/SHA256; the outer verification.json is published last as a completion marker.',
      'No signing, physical-device, complete redistribution-license or production-release claim is made.',
      ''
    ]).join('\n')
