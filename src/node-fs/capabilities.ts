import { FS_NATIVE_MODULE, FS_OPERATION_VERSION, FS_ROOT_AUTHORITIES, FS_VIRTUAL_SCHEME } from './constants.js'

const supported = (notes: string) => Object.freeze({ notes, status: 'supported' as const })
const partial = (notes: string) => Object.freeze({ notes, status: 'partial' as const })
const unsupported = (notes: string) => Object.freeze({ notes, status: 'unsupported' as const })

/** Machine-readable inventory. This deliberately does not claim full node:fs. */
export const FS_API_SUPPORT = Object.freeze({
  access: partial('Async F_OK/R_OK/W_OK checks on virtual URLs; X_OK is unsupported.'),
  appendFile: supported('Async string/Uint8Array/ArrayBuffer append through chunked handle writes.'),
  chmod: partial('Async numeric mode requires the write root grant; no platform ACL translation.'),
  constants: partial('Portable v1 access/open/copy flags only.'),
  cp: partial('Atomic files and recursive directories; filter, dereference and preserveTimestamps are unavailable.'),
  createReadStream: partial('Credit-driven AsyncIterable stream; not a Node Readable/EventEmitter.'),
  createWriteStream: unsupported('Native Bridge v1 has no provider-to-guest write-credit contract.'),
  existsSync: unsupported('v1 does not fabricate synchronous I/O.'),
  fileHandleClose: supported('Idempotent guest close and provider exactly-once handle release.'),
  fileHandleRead: supported('Bounded Uint8Array reads.'),
  fileHandleStat: supported('Bounded immutable stat result.'),
  fileHandleSync: supported('Async provider durability barrier; reference provider is an in-memory no-op.'),
  fileHandleWrite: supported('Bounded Uint8Array writes with unary completion backpressure.'),
  link: unsupported('Hard links require production-host inode and cross-root semantics not present in v1.'),
  lstat: supported('Returns bounded link metadata without following a virtual symlink.'),
  mkdir: supported('Async single or recursive directory creation.'),
  mkdtemp: unsupported('Unique-name allocation is not part of the v1 operation contract.'),
  open: partial('Portable string/numeric flags including O_DIRECTORY and final-component O_NOFOLLOW.'),
  promises: partial('The explicitly listed async v1 subset only.'),
  readFile: supported('Credit-streamed transport with bounded guest aggregation and utf8 decoding.'),
  readFileSync: unsupported('v1 does not busy-wait, use Atomics, or claim snapshot synchrony.'),
  readdir: partial('utf8 names and immutable Dirent objects; bounded result size.'),
  readlink: supported('Returns a same-authority virtual symlink target.'),
  realpath: partial('Canonical virtual URL with bounded same-authority symlink resolution.'),
  rename: partial('Atomic same-authority rename only; cross-authority returns EXDEV.'),
  rm: supported('Async force/recursive removal.'),
  stat: supported('Bounded immutable file/directory metadata.'),
  symlink: partial('Same-authority virtual URL targets only; relative/native targets are rejected.'),
  syncApis: unsupported('No synchronous facade is implemented in v1.'),
  watch: partial('Credit-driven, bounded AsyncIterable events; overflow closes the watch with ENOSPC.'),
  writeFile: partial(
    'Default truncate flags use a provider-owned opaque transaction and atomic commit; exclusive flags are unsupported.'
  )
})

export const FS_CAPABILITY_MATRIX = Object.freeze({
  api: FS_API_SUPPORT,
  authority: Object.freeze({
    capabilitiesTravelOutOfBand: true,
    principalTravelsOutOfBand: true,
    providerReauthorizationRequired: true,
    rootAllocationTravelsOutOfBand: true,
    roots: FS_ROOT_AUTHORITIES,
    scheme: FS_VIRTUAL_SCHEME
  }),
  contract: Object.freeze({
    module: FS_NATIVE_MODULE,
    operationVersion: FS_OPERATION_VERSION,
    requestModes: Object.freeze(['result', 'stream'] as const)
  }),
  errors: Object.freeze(
    [
      'ENOENT',
      'EEXIST',
      'EACCES',
      'EPERM',
      'EISDIR',
      'ENOTDIR',
      'ENOTEMPTY',
      'EBADF',
      'EINVAL',
      'ENOSPC',
      'EXDEV',
      'ECANCELED',
      'ETIMEDOUT'
    ] as const
  ),
  paths: Object.freeze({
    absoluteNativePaths: 'rejected',
    crossAuthorityLinks: 'EXDEV',
    crossAuthorityRename: 'EXDEV',
    dotTraversal: 'rejected',
    encodedSeparators: 'rejected',
    nul: 'rejected'
  }),
  streaming: Object.freeze({
    largeRead: 'native-credit-stream',
    largeWrite: 'bounded-unary-chunk-ack',
    nodeReadableCompatibility: 'partial',
    nodeWritableCompatibility: 'unsupported'
  }),
  transactions: Object.freeze({
    writeFile:
      'provider-owned opaque fs.atomic-write resource; staged bytes never enter the directory namespace; commit atomically replaces the target; resource close, request cancel, undelivered grant, and provider dispose roll back an uncommitted transaction exactly once'
  }),
  version: 1
})
