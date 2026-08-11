export const createProcessOutputPublisher = store => async input => {
  const streams = [...new Set(input.admitted.map(event => event.stream))].sort()
  const logCursor = input.appended.at(-1)?.sequence
  return await store.transact(
    result => ({ data: result, subject: input.process.id, type: 'process.output' }),
    () => ({
      count: input.admitted.length,
      generation: input.process.generation,
      ...(logCursor == null ? {} : { logCursor }),
      processId: input.process.id,
      sourceCursor: input.sourceCursor,
      streams
    })
  )
}
