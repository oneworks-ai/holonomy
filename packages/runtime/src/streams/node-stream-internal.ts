import type { Stream } from './node-stream-base.js'

const beforeErrorHooks = new WeakMap<Stream, Set<() => void>>()

/** Leaf-only coordination for Runtime Stream.pipe; deliberately absent from barrels. */
export const registerBeforeErrorHook = (stream: Stream, hook: () => void): () => void => {
  const hooks = beforeErrorHooks.get(stream) ?? new Set<() => void>()
  hooks.add(hook)
  beforeErrorHooks.set(stream, hooks)
  return () => {
    hooks.delete(hook)
    if (hooks.size === 0) beforeErrorHooks.delete(stream)
  }
}

export const runBeforeErrorHooks = (stream: Stream): void => {
  for (const hook of [...(beforeErrorHooks.get(stream) ?? [])]) {
    try {
      hook()
    } catch {
      // Hooks are cleanup-only. Preserve the original EventEmitter error path.
    }
  }
}
