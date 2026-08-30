const supported = (notes: string) => Object.freeze({ notes, status: 'supported' as const })
const partial = (notes: string) => Object.freeze({ notes, status: 'partial' as const })
const unsupported = (notes: string) => Object.freeze({ notes, status: 'unsupported' as const })

/** Machine-readable v1 inventory; this is a static contract, not host wiring. */
export const CHILD_PROCESS_CAPABILITY_MATRIX = Object.freeze({
  api: Object.freeze({
    execFile: partial('Callback-only; literal git command registry with no shell or PATH lookup.'),
    gitClone: partial('git clone --depth 1 [--branch <branch>] <url> <holonomy-fs destination>.'),
    gitRemoteConfig: supported('git -C <holonomy-fs URL> config --get-regexp ^remote\\..*\\.url$.')
  }),
  lifecycle: Object.freeze({
    cancellation: 'adapter-owned first terminal races genuine platform AbortSignal against GitFacade completion',
    deadlines: 'adapter-owned timeout terminal forwards GitFacade timeoutMs and wins over late completion',
    repositoryClose: 'adapter closes each temporary and late-resolving repository exactly once'
  }),
  limits: Object.freeze({
    maxArgBytes: 'runtime-enforced before GitFacade admission',
    maxArgCount: 'runtime-enforced before GitFacade admission',
    maxStderrBytes: 'runtime-enforced; v1 stderr is always empty',
    maxStdoutBytes: 'runtime-enforced before callback delivery'
  }),
  module: 'node:child_process',
  divergences: Object.freeze({
    callbackThrow: partial(
      'User callback exceptions are swallowed so internal scheduling never creates an unhandled rejection.'
    ),
    signal: partial('Only a genuine captured platform AbortSignal is accepted when that platform constructor exists.')
  }),
  unsupported: Object.freeze({
    exec: unsupported('Shell command strings are unavailable.'),
    execFileSync: unsupported('Synchronous process APIs are unavailable.'),
    fork: unsupported('Child runtimes are unavailable.'),
    pathLookup: unsupported('Only literal git is accepted; no PATH aliases or native paths.'),
    shell: unsupported('No shell, metacharacter or command interpolation is interpreted.'),
    spawn: unsupported('Native process creation is unavailable.'),
    spawnSync: unsupported('Synchronous process APIs are unavailable.')
  }),
  version: 1
})
