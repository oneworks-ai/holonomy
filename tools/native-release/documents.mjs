// One owner for copied documentation and its manifest entries.
export const NATIVE_BUNDLE_DOCUMENTS = Object.freeze({
  LICENSE: 'LICENSE',
  'README.md': 'adapters/desktop/README.md',
  'README.zh-Hans.md': 'adapters/desktop/README.zh-Hans.md',
  'host-configuration.md': 'adapters/desktop/host-configuration.md',
  'host-configuration.zh-Hans.md': 'adapters/desktop/host-configuration.zh-Hans.md',
  'crypto.md': 'adapters/desktop/crypto.md',
  'crypto.zh-Hans.md': 'adapters/desktop/crypto.zh-Hans.md',
  'storage.md': 'adapters/desktop/storage.md',
  'storage.zh-Hans.md': 'adapters/desktop/storage.zh-Hans.md',
  'device.md': 'adapters/desktop/device.md',
  'device.zh-Hans.md': 'adapters/desktop/device.zh-Hans.md',
  'observer.md': 'adapters/desktop/observer.md',
  'observer.zh-Hans.md': 'adapters/desktop/observer.zh-Hans.md',
  'observer-profiles.md': 'adapters/desktop/observer-profiles.md',
  'observer-profiles.zh-Hans.md': 'adapters/desktop/observer-profiles.zh-Hans.md',
  'managed-observer-profiles.md': 'adapters/desktop/managed-observer-profiles.md',
  'managed-observer-profiles.zh-Hans.md': 'adapters/desktop/managed-observer-profiles.zh-Hans.md',
  'process-native-darwin.md': 'adapters/desktop/process-native-darwin.md',
  'process-native-darwin.zh-Hans.md': 'adapters/desktop/process-native-darwin.zh-Hans.md',
  'process-v86-network.md': 'adapters/desktop/process-v86-network.md',
  'process-v86-network.zh-Hans.md': 'adapters/desktop/process-v86-network.zh-Hans.md',
  'process-v86-capabilities.md': 'adapters/desktop/process-v86-capabilities.md',
  'process-v86-capabilities.zh-Hans.md': 'adapters/desktop/process-v86-capabilities.zh-Hans.md',
  'engine-gate.md': 'adapters/desktop/engine-gate.md',
  'engine-gate.zh-Hans.md': 'adapters/desktop/engine-gate.zh-Hans.md',
  'managed-engine-gates.md': 'adapters/desktop/managed-engine-gates.md',
  'managed-engine-gates.zh-Hans.md': 'adapters/desktop/managed-engine-gates.zh-Hans.md',
  'managed-source-audit.md': 'adapters/desktop/managed-source-audit.md',
  'managed-source-audit.zh-Hans.md': 'adapters/desktop/managed-source-audit.zh-Hans.md',
  'inspector.md': 'adapters/desktop/inspector.md',
  'inspector.zh-Hans.md': 'adapters/desktop/inspector.zh-Hans.md'
})

export const NATIVE_DEVELOPMENT_INSTRUCTIONS = `# Holonomy native development artifact

Run ./bin/holo ./index.js. Node.js and this source checkout are not runtime dependencies.
This artifact is development-only, unsigned and not notarized. The included LICENSE covers
Holonomy itself. THIRD-PARTY-NOTICES.json and sbom.spdx.json bind reviewed engine notices,
embedded asset hashes and both lock inventories. They do not establish a complete
redistribution license closure; review the unresolved entries before any release.
Do not publish this archive as a release. manifest.json records the exact binary, embedded
JS asset digests and build-input hashes; it is not a reproducible-build attestation.
See the included English and Chinese usage guides for the verified support boundary.
`
