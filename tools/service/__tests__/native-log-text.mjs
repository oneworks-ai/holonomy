// Service log records are transport chunks, not lines. Keep both stream and
// generation identity while reconstructing text for public journey assertions.
export const nativeLogContains = (page, marker, generation) => {
  const streams = new Map()
  for (const event of page.events) {
    if (generation !== undefined && event.generation !== generation) continue
    const key = JSON.stringify([event.generation, event.stream])
    streams.set(key, (streams.get(key) ?? '') + event.chunk)
  }
  return [...streams.values()].some(text => text.includes(marker))
}
