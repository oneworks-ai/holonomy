import type { NodeFsFacade } from './types.js'

export interface SyntheticModuleNamespace {
  readonly default: unknown
  readonly named: Readonly<Record<string, unknown>>
}

/**
 * Host module loaders can install these namespaces for `node:fs` and
 * `node:fs/promises` without importing a Node shim into the mobile runtime.
 */
export const createFsSyntheticModules = (fs: NodeFsFacade) => {
  const promises = Object.freeze({ ...fs.promises })
  const fsModule = Object.freeze({
    constants: fs.constants,
    createReadStream: fs.createReadStream.bind(fs),
    createWriteStream: fs.createWriteStream.bind(fs),
    existsSync: fs.existsSync.bind(fs),
    promises,
    readFileSync: fs.readFileSync.bind(fs),
    watch: fs.watch.bind(fs)
  })
  return new Map<string, SyntheticModuleNamespace>([
    ['node:fs', Object.freeze({ default: fsModule, named: fsModule })],
    ['node:fs/promises', Object.freeze({ default: promises, named: promises })]
  ])
}
