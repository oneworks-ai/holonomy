// Only Engine Gate's validated primitive metadata reaches this callback.
// Fixed encoding avoids Host plugin replacements of JSON/Object/toJSON.
export const createNativeSourceReadAudit = native => {
  const record = native.sourceReadAudit
  return (input, readBytes) =>
    record(
      `{"codeKind":"${input.codeKind}","readBytes":${readBytes},"requestId":${input.requestId},` +
        `"sourceBytes":${input.sourceBytes},"sourceSha256":"${input.sourceSha256}"}`
    )
}
