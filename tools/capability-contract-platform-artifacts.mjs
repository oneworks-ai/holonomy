export const platformContractArtifacts = api => [[
  'virtual-path-v1.vectors.json',
  {
    invalid: [
      'holo-fs://workspace/../secret',
      'holo-fs://workspace/%2e%2e/secret',
      'holo-fs://workspace/%2Fsecret',
      'holo-fs://workspace/%41',
      'holo-fs://workspace//file',
      'holo-fs://workspace/file?query=1',
      'holo-fs://workspace/file#fragment',
      'holo-fs://workspace/raw\\path'
    ],
    schemaVersion: 1,
    valid: [
      'holo-fs://workspace/',
      'holo-fs://workspace/src/main.js',
      'holo-fs://workspace/%E6%96%87%E4%BB%B6.txt'
    ].map(input => ({ input, normalized: api.canonicalVirtualPath(input) }))
  }
], [
  'device-contract-v1.vectors.json',
  {
    schemaVersion: 1,
    vectors: {
      androidProvider: api.compileDeviceProviderDescriptorV1(
        api.androidDeviceDescriptorInput(api.deviceOperations)
      ),
      desktopProvider: api.compileDeviceProviderDescriptorV1(
        api.deviceDescriptorInput('desktop', api.deviceOperations)
      ),
      nodeProvider: api.compileDeviceProviderDescriptorV1(
        api.deviceDescriptorInput('node', api.deviceOperations)
      ),
      tierOneSummary: api.normalizeDeviceSummaryV1(api.deviceSummaryInput)
    }
  }
]]
