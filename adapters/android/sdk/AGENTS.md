# Android development SDK

`consumer/` is the source template for an independent Gradle App consuming packaged AAR files, not an E2E project or a production provider. `tools/android-sdk/` owns build, manifest, archive and verification. The packager supplies the wrapper, shared Crypto JS workload and eight explicitly selected AARs; do not commit generated libraries or build output here.

The consumer intentionally uses only four core/Crypto AARs plus Javet. Its Kotlin test assembles the production engine and checks the shared JavaScript test terminal. It does not implement assertions for public JS APIs, grant network/storage/process access or prove all optional module integrations. SDK inventory verification and actual consumer/device acceptance are separate gates.
