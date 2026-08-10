import type { NativeBridge } from '../native-port/types.js'
import type { FsAuthorityInput, FsPermission } from '../node-fs/types.js'
import type { NetworkAuthority, ResolvedNetworkAuthority } from '../web-network/types.js'

export type GitCapability =
  | 'clone'
  | 'config.read'
  | 'fetch'
  | 'push'
  | 'remote.read'
  | 'repository.open'
  | 'status'

export type GitCredentialOperation = 'clone' | 'fetch' | 'push'

export interface GitCredentialGrantInput {
  allowedOrigins: readonly string[]
  operations: readonly GitCredentialOperation[]
  reference: string
}

export interface GitCredentialGrant {
  readonly allowedOrigins: readonly string[]
  readonly operations: readonly GitCredentialOperation[]
  readonly reference: string
}

export interface GitLimits {
  maxChangedFiles: number
  maxConcurrentOperations: number
  maxConfigValueBytes: number
  maxOpenRepositories: number
  maxProgressEvents: number
  maxRefBytes: number
  maxRemotes: number
  maxTransferBytes: number
}

export interface GitAuthorityInput {
  capabilities: readonly string[]
  configKeys: readonly string[]
  credentials?: readonly GitCredentialGrantInput[]
  filesystem: FsAuthorityInput
  limits?: Partial<GitLimits>
  network: NetworkAuthority
  operations: readonly GitCapability[]
  principal: string
}

export interface GitAuthority {
  readonly capabilities: readonly string[]
  readonly configKeys: readonly string[]
  readonly credentials: readonly GitCredentialGrant[]
  readonly filesystem: Readonly<import('../node-fs/types.js').FsAuthority>
  readonly limits: Readonly<GitLimits>
  readonly network: Readonly<ResolvedNetworkAuthority>
  readonly operations: readonly GitCapability[]
  readonly principal: string
}

export interface GitCallOptions {
  /** Absolute monotonic deadline in the shared Native Bridge scheduler domain. */
  deadlineMs?: number
  onProgress?: (progress: Readonly<GitProgress>) => void
  signal?: AbortSignal
  timeoutMs?: number
}

export interface GitCloneOptions {
  branch?: string
  credentialRef?: string
  depth?: number
  destination: string
  url: string
}

export interface GitFetchOptions {
  credentialRef?: string
  prune?: boolean
  remote: string
}

export interface GitPushOptions {
  credentialRef?: string
  destinationRef: string
  forceWithLease?: boolean
  remote: string
  setUpstream?: boolean
  sourceRef: string
}

export interface GitProgress {
  completed: number
  phase: 'checkout' | 'compress' | 'negotiate' | 'receive' | 'resolve' | 'update' | 'write'
  total?: number
  unit: 'bytes' | 'objects' | 'steps'
}

export interface GitChangedFile {
  path: string
  staged: boolean
  status: 'added' | 'conflicted' | 'deleted' | 'modified' | 'renamed' | 'untracked'
  unstaged: boolean
}

export interface GitStatus {
  ahead: number
  behind: number
  changedFiles: readonly GitChangedFile[]
  currentBranch: string | null
  detached: boolean
  head: string | null
  upstream: string | null
}

export interface GitRemote {
  authorized: boolean
  fetchUrl?: string
  name: string
  pushUrl?: string
}

export interface GitFetchResult {
  head: string | null
  updatedRefs: readonly string[]
}

export interface GitPushResult {
  remoteRefs: readonly string[]
  updated: boolean
}

export interface GitRepository {
  close(reason?: string): boolean
  configGet(key: string, options?: GitCallOptions): Promise<string | null>
  fetch(input: GitFetchOptions, options?: GitCallOptions): Promise<GitFetchResult>
  listRemotes(options?: GitCallOptions): Promise<readonly GitRemote[]>
  push(input: GitPushOptions, options?: GitCallOptions): Promise<GitPushResult>
  status(options?: GitCallOptions): Promise<GitStatus>
}

export interface GitFacade {
  clone(input: GitCloneOptions, options?: GitCallOptions): Promise<GitRepository>
  open(path: string, options?: GitCallOptions): Promise<GitRepository>
}

export interface GitFacadeOptions {
  authority: GitAuthorityInput
  bridge: NativeBridge
}

export interface AuthorizedGitPath {
  readonly href: string
  readonly permission: FsPermission
  readonly rootId: string
}
