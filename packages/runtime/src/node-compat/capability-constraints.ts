export const BUFFER_CONSTRAINTS = [
  'Buffer is Uint8Array-based and does not depend on a Node global Buffer.',
  'allocUnsafe is intentionally zero-filled; no uninitialized memory is exposed.',
  'ArrayBuffer offset/length views, malformed UTF-8 replacement and numeric toString ranges match the tested Node subset.',
  'Base64 decoding ignores non-alphabet characters and stops at padding; its byteLength is Node raw-length estimation and may exceed decoded bytes.',
  'Hex decoding truncates at the first invalid pair or trailing nibble; its byteLength is floor(raw code units / 2).',
  'Bytes cross host ports as Uint8Array, never as implicit base64.'
] as const

export const EVENTS_CONSTRAINTS = [
  'Listeners execute synchronously in registration order.',
  'Max-listener counts are retained, but warning emission is omitted.'
] as const

export const OS_CONSTRAINTS = [
  'All values come from an immutable host snapshot.',
  'Host identityPolicy must be synthetic; home and temp paths stay under virtualRoot.',
  'Real Android absolute paths and device-identifying usernames or hostnames are forbidden.'
] as const

export const PATH_CONSTRAINTS = [
  'All paths use POSIX syntax and are pure lexical transformations.',
  'path.resolve and path.relative use the injected process cwd.',
  'node:path does not enforce virtualRoot; the future filesystem authority must apply sandbox checks before I/O.',
  'Windows drive letters, UNC paths and backslash separators are not modeled.'
] as const

export const PROCESS_CONSTRAINTS = [
  'Process fields are immutable clones of a host snapshot.',
  'cwd and execPath stay under virtualRoot; env is read-only.',
  'Uint8Array writes are copied at admission and provider failures expose only sanitized RuntimeNodeCoreError values.',
  'Each write is rejected before byte copying or provider invocation when its UTF-8 or binary size exceeds frozen maxStdioChunkBytes; the default is 1048576 bytes.',
  'Host adapters may inject a lower maxStdioChunkBytes transport limit.',
  'Synchronous providers return boolean; asynchronous providers return Promise<boolean>, so Node stream backpressure compatibility is partial.',
  'Dangerous or meaningless process controls throw ERR_HOLONOMY_NOT_SUPPORTED.'
] as const

export const URL_CONSTRAINTS = [
  'URL constructors use injectable Web standards when engine globals are absent.',
  'fileURLToPath accepts only local file: URLs and a configured app: origin with a non-empty host.',
  'File-like paths, decoded separators and traversal cannot escape virtualRoot.',
  'pathToFileURL emits a canonicalized virtual path, so dot segments and repeated POSIX separators do not round-trip.',
  'pathToFileURL percent-encoding is partial: [ ] | and ^ remain literal instead of matching Node percent encoding.'
] as const
