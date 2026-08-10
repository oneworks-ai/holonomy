const supported = (notes: string) => Object.freeze({ notes, status: 'supported' as const })
const partial = (notes: string) => Object.freeze({ notes, status: 'partial' as const })
const unsupported = (notes: string) => Object.freeze({ notes, status: 'unsupported' as const })

/** Machine-readable v1 inventory; it is a contract, not an Android/JGit wiring claim. */
export const GIT_CAPABILITY_MATRIX = Object.freeze({
  api: Object.freeze({
    clone: partial(
      'Authorized HTTP(S), optional branch/depth and credential reference; no submodules or arbitrary checkout.'
    ),
    configGet: partial('Repository config keys must be explicitly allowlisted; no system/global config or writes.'),
    fetch: partial('Configured remote only; provider-defined refspecs, optional prune and no arbitrary refspec input.'),
    push: partial(
      'Explicit branch-to-branch update; force requires force-with-lease and provider authorization; deletion is unavailable.'
    ),
    remoteList: partial('Unauthorized URLs are omitted and embedded credentials are never returned.'),
    repositoryOpen: supported('Authorized mobile-fs workspace URL becomes a Bridge-issued opaque repository handle.'),
    status: partial('Branch, head, upstream, ahead/behind and bounded changed-file metadata; no patches or history.')
  }),
  consumers: Object.freeze({
    launcherClone: Object.freeze({ coveredBy: Object.freeze(['clone']), status: 'supported' }),
    managedPluginGitSource: Object.freeze({
      coveredBy: Object.freeze(['clone']),
      notes: 'branch/depth clone only; pinned SHA checkout and git-subdir extraction remain host orchestration',
      status: 'partial'
    }),
    sessionGitControls: Object.freeze({
      coveredBy: Object.freeze(['status', 'remoteList', 'fetch', 'push']),
      notes: 'commit, checkout, worktrees and diff are outside Git v1',
      status: 'partial'
    })
  }),
  lifecycle: Object.freeze({
    cancellation: 'AbortSignal through Native Bridge',
    deadlines: 'shared Native Bridge monotonic deadline',
    progress: 'credit-driven Native Bridge stream',
    repositoryIdentity: 'opaque Native Bridge resource',
    shutdown: 'Native Bridge resource disposal backstop'
  }),
  locks: Object.freeze({
    clone: 'exclusive destination allocation lock owned by provider/host FS coordination',
    fetch: 'exclusive repository write lock owned by provider',
    push: 'exclusive repository write lock owned by provider, including optional upstream mutation',
    reads: 'shared repository read lock owned by provider'
  }),
  limits: Object.freeze({
    maxChangedFiles: 'runtime-enforced when decoding Git result arrays',
    maxConcurrentOperations: 'provider-owned admission limit; Git facade does not claim runtime enforcement',
    maxConfigValueBytes: 'runtime-enforced on decoded UTF-8 config values',
    maxOpenRepositories: 'provider-owned admission limit; Git facade does not claim runtime enforcement',
    maxProgressEvents: 'runtime-enforced while consuming a Git progress stream',
    maxRefBytes: 'runtime-enforced on public ref inputs',
    maxRemotes: 'runtime-enforced when decoding remote arrays',
    maxTransferBytes: 'runtime-enforced on decoded byte progress values; provider also enforces transfer admission'
  }),
  module: 'host.git',
  security: Object.freeze({
    credentials: 'host-owned secret resolved only from an authorized opaque reference',
    paths: 'mobile-fs://workspace authority only',
    remoteSchemes: Object.freeze(['http', 'https']),
    providerReauthorizationRequired: true,
    stableRedactedErrors: true
  }),
  unsupported: Object.freeze({
    arbitraryShell: unsupported('No command or argv surface.'),
    checkout: unsupported('No general checkout, reset or ref mutation in v1.'),
    commit: unsupported('Index mutation, signing and hooks are outside v1.'),
    credentialHelper: unsupported('No native credential helper, environment, home or keychain reads.'),
    diff: unsupported('Patch, diffstat and raw tree comparison APIs are outside v1.'),
    gitHooks: unsupported('Providers must not execute Git hooks.'),
    history: unsupported('Commit-log, revision-walk and blame APIs are outside v1.'),
    nativePaths: unsupported('Absolute/native/file URLs are rejected.'),
    rawConfig: unsupported('No config listing or write API.'),
    rawRefspec: unsupported('Guest-provided arbitrary refspecs and deletion pushes are rejected.'),
    ssh: unsupported('SSH/scp/git protocols are outside HTTP(S)-only v1.'),
    submodules: unsupported('Submodule traversal and recursive clone/fetch are outside v1.'),
    worktrees: unsupported('Linked worktree management is outside v1.')
  }),
  version: 1
})
