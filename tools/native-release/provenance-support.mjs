export const json = value => `${JSON.stringify(value, null, 2)}\n`

export const spdxPackage = (id, name, version, downloadLocation, checksum, licenseDeclared) => ({
  SPDXID: id,
  name,
  versionInfo: version,
  downloadLocation: downloadLocation ?? 'NOASSERTION',
  filesAnalyzed: false,
  licenseConcluded: 'NOASSERTION',
  licenseDeclared,
  ...(checksum == null ? {} : { checksums: [{ algorithm: checksum.algorithm, checksumValue: checksum.value }] })
})
