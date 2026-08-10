import {
  BUFFER_CONSTRAINTS,
  EVENTS_CONSTRAINTS,
  OS_CONSTRAINTS,
  PATH_CONSTRAINTS,
  PROCESS_CONSTRAINTS,
  URL_CONSTRAINTS
} from './capability-constraints.js'

export type NodeCoreFeatureStatus = 'partial' | 'supported' | 'unsupported'

export interface NodeCoreFeatureCapability {
  readonly status: NodeCoreFeatureStatus
}

export interface NodeCoreModuleCapability {
  readonly constraints: readonly string[]
  readonly features: Readonly<Record<string, NodeCoreFeatureCapability>>
  readonly partial: readonly string[]
  readonly status: NodeCoreFeatureStatus
  readonly supported: readonly string[]
  readonly unsupported: readonly string[]
}

const moduleCapability = (
  supported: readonly string[],
  partial: readonly string[],
  unsupported: readonly string[],
  constraints: readonly string[]
): NodeCoreModuleCapability => {
  const features = Object.fromEntries([
    ...supported.map(name => [name, Object.freeze({ status: 'supported' })]),
    ...partial.map(name => [name, Object.freeze({ status: 'partial' })]),
    ...unsupported.map(name => [name, Object.freeze({ status: 'unsupported' })])
  ])
  return Object.freeze({
    constraints: Object.freeze([...constraints]),
    features: Object.freeze(features),
    partial: Object.freeze([...partial]),
    status: 'partial',
    supported: Object.freeze([...supported]),
    unsupported: Object.freeze([...unsupported])
  })
}

export const NODE_CORE_CAPABILITY_MATRIX = Object.freeze(
  {
    modules: Object.freeze({
      'node:buffer': moduleCapability(
        [
          'Buffer.from.string',
          'Buffer.from.arrayLike',
          'Buffer.from.ArrayBuffer',
          'Buffer.alloc',
          'Buffer.byteLength.utf8',
          'Buffer.byteLength.base64',
          'Buffer.byteLength.base64url',
          'Buffer.byteLength.hex',
          'Buffer.isBuffer',
          'Buffer.concat',
          'Buffer.subarray',
          'Buffer.slice',
          'Buffer.toString',
          'Buffer.equals',
          'encoding.utf8',
          'encoding.base64.encode',
          'encoding.base64.decode',
          'encoding.base64url.encode',
          'encoding.base64url.decode',
          'encoding.hex.encode',
          'encoding.hex.decode'
        ],
        [
          'Buffer.allocUnsafe',
          'Buffer.from.objectCoercion',
          'encoding.base64.malformedInput',
          'encoding.base64url.malformedInput',
          'encoding.hex.malformedInput'
        ],
        [
          'Buffer.from.SharedArrayBuffer',
          'Buffer.transcode',
          'Blob',
          'File',
          'SlowBuffer'
        ],
        BUFFER_CONSTRAINTS
      ),
      'node:events': moduleCapability(
        [
          'EventEmitter.on',
          'EventEmitter.once',
          'EventEmitter.off',
          'EventEmitter.addListener',
          'EventEmitter.removeListener',
          'EventEmitter.removeAllListeners',
          'EventEmitter.emit',
          'EventEmitter.listeners',
          'EventEmitter.listenerCount',
          'EventEmitter.setMaxListeners',
          'EventEmitter.getMaxListeners',
          'EventEmitter.errorEvent'
        ],
        ['EventEmitter.maxListenerWarnings'],
        ['captureRejections', 'EventEmitterAsyncResource', 'events.on', 'events.once'],
        EVENTS_CONSTRAINTS
      ),
      'node:os': moduleCapability(
        [
          'os.arch',
          'os.platform',
          'os.release',
          'os.type',
          'os.hostname',
          'os.homedir',
          'os.tmpdir',
          'os.userInfo'
        ],
        ['os.snapshotValues'],
        ['os.cpus', 'os.freemem', 'os.networkInterfaces', 'os.totalmem', 'os.uptime'],
        OS_CONSTRAINTS
      ),
      'node:path': moduleCapability(
        [
          'path.basename',
          'path.dirname',
          'path.extname',
          'path.isAbsolute',
          'path.join',
          'path.parse',
          'path.relative',
          'path.resolve',
          'path.sep',
          'path.delimiter',
          'path.posix.normalize',
          'path.posix.basename',
          'path.posix.relative'
        ],
        ['path.posixOnly'],
        ['path.win32', 'path.toNamespacedPath'],
        PATH_CONSTRAINTS
      ),
      'node:process': moduleCapability(
        [
          'process.env',
          'process.cwd',
          'process.pid',
          'process.platform',
          'process.arch',
          'process.versions.node',
          'process.argv',
          'process.execPath',
          'process.on',
          'process.off',
          'process.once',
          'process.stdio.byteAdmissionCopy',
          'process.stdio.chunkLimit',
          'process.stdio.providerFailureMapping'
        ],
        [
          'process.events',
          'process.stdio',
          'process.stdout.write',
          'process.stderr.write',
          'process.stdio.backpressure'
        ],
        [
          'process.abort',
          'process.chdir',
          'process.exit',
          'process.kill',
          'process.setgid',
          'process.setuid',
          'process.umask',
          'process.nextTick'
        ],
        PROCESS_CONSTRAINTS
      ),
      'node:url': moduleCapability(
        ['URL', 'URLSearchParams'],
        ['url.fileURLToPath', 'url.pathToFileURL'],
        ['url.domainToASCII', 'url.domainToUnicode', 'url.parse', 'url.resolve'],
        URL_CONSTRAINTS
      )
    }),
    platformModel: 'mobile-posix-virtual',
    version: 1
  } as const
)

export type NodeCoreModuleSpecifier = keyof typeof NODE_CORE_CAPABILITY_MATRIX.modules
