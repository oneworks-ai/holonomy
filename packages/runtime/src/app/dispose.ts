export const disposeQuietly = async (
  value: { dispose(): void | Promise<void> } | undefined
) => {
  try {
    await value?.dispose()
  } catch {}
}
