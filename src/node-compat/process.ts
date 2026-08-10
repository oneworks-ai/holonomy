import { invalidArgument, notSupported } from './errors.js'
import { EventEmitter } from './events.js'
import type { NodeEventListener } from './events.js'
import { resolveMaxStdioChunkBytes } from './options.js'
import { createRuntimeWritable } from './stdio.js'
import type { RuntimeWritable } from './stdio.js'
import type { RuntimeProcessSnapshot, RuntimeStdioProvider } from './types.js'
import { assertPathWithinVirtualRoot } from './virtual-path.js'

export type { RuntimeWritable } from './stdio.js'

export interface RuntimeProcess {
  readonly arch: string
  readonly argv: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly execPath: string
  readonly pid: number
  readonly platform: string
  readonly stderr: RuntimeWritable
  readonly stdout: RuntimeWritable
  readonly versions: Readonly<{ node: string }>
  abort(): never
  addListener(eventName: string | symbol, listener: NodeEventListener): RuntimeProcess
  chdir(directory: string): never
  cwd(): string
  emit(eventName: string | symbol, ...args: unknown[]): boolean
  exit(code?: number): never
  kill(pid: number, signal?: string | number): never
  nextTick(callback: NodeEventListener, ...args: unknown[]): never
  off(eventName: string | symbol, listener: NodeEventListener): RuntimeProcess
  on(eventName: string | symbol, listener: NodeEventListener): RuntimeProcess
  once(eventName: string | symbol, listener: NodeEventListener): RuntimeProcess
  removeListener(eventName: string | symbol, listener: NodeEventListener): RuntimeProcess
  setgid(id: number | string): never
  setuid(id: number | string): never
  umask(mask?: number | string): never
}

const cloneSnapshot = (
  snapshot: RuntimeProcessSnapshot,
  virtualRoot: string
): RuntimeProcessSnapshot => {
  if (!Number.isSafeInteger(snapshot.pid) || snapshot.pid <= 0) {
    invalidArgument('process.pid', 'process.pid must be a positive safe integer')
  }
  if (!snapshot.arch || !snapshot.platform || !snapshot.versions.node) {
    invalidArgument('process', 'process arch, platform and versions.node are required')
  }
  const cwd = assertPathWithinVirtualRoot(snapshot.cwd, virtualRoot, 'process.cwd')
  const execPath = assertPathWithinVirtualRoot(
    snapshot.execPath,
    virtualRoot,
    'process.execPath'
  )
  const env = Object.freeze({ ...snapshot.env })
  if (Object.values(env).some(value => typeof value !== 'string')) {
    invalidArgument('process.env', 'process.env values must be strings')
  }
  return Object.freeze({
    ...snapshot,
    argv: Object.freeze([...snapshot.argv]),
    cwd,
    env,
    execPath,
    versions: Object.freeze({ node: snapshot.versions.node })
  })
}

export type ProcessSyntheticModule = RuntimeProcess & {
  readonly default: RuntimeProcess
}

export const createProcessSyntheticModule = (
  snapshotInput: RuntimeProcessSnapshot,
  virtualRoot: string,
  stdio: RuntimeStdioProvider,
  maxStdioChunkBytes?: number
): ProcessSyntheticModule => {
  const snapshot = cloneSnapshot(snapshotInput, virtualRoot)
  const stdioChunkLimit = resolveMaxStdioChunkBytes(maxStdioChunkBytes)
  const emitter = new EventEmitter()
  const unsupported = (feature: string) => () => notSupported(`process.${feature}`)
  const runtimeProcess: RuntimeProcess = {
    abort: unsupported('abort'),
    addListener(eventName, listener) {
      emitter.addListener(eventName, listener)
      return runtimeProcess
    },
    arch: snapshot.arch,
    argv: snapshot.argv,
    chdir: unsupported('chdir'),
    cwd: () => snapshot.cwd,
    emit: (eventName, ...args) => emitter.emit(eventName, ...args),
    env: snapshot.env,
    execPath: snapshot.execPath,
    exit: unsupported('exit'),
    kill: unsupported('kill'),
    nextTick: unsupported('nextTick'),
    off(eventName, listener) {
      emitter.off(eventName, listener)
      return runtimeProcess
    },
    on(eventName, listener) {
      emitter.on(eventName, listener)
      return runtimeProcess
    },
    once(eventName, listener) {
      emitter.once(eventName, listener)
      return runtimeProcess
    },
    pid: snapshot.pid,
    platform: snapshot.platform,
    removeListener(eventName, listener) {
      emitter.removeListener(eventName, listener)
      return runtimeProcess
    },
    setgid: unsupported('setgid'),
    setuid: unsupported('setuid'),
    stderr: createRuntimeWritable('stderr', stdio, stdioChunkLimit),
    stdout: createRuntimeWritable('stdout', stdio, stdioChunkLimit),
    umask: unsupported('umask'),
    versions: snapshot.versions
  }
  const frozenProcess = Object.freeze(runtimeProcess)
  return Object.freeze({ ...frozenProcess, default: frozenProcess })
}
