export const createProcessListenerProfile = () => ({
  profile: 'process-profile-v1',
  backend: {
    backendId: 'native.darwin-seatbelt-v1',
    configuration: { runtimeReadPaths: [], sandboxExecutablePath: '/usr/bin/sandbox-exec' }
  },
  environment: { allowedScopes: ['processTree'], defaultScope: 'processTree' },
  executables: [{
    executableId: 'echo',
    executable: { kind: 'hostPath', path: '/bin/echo' },
    fixedArgs: [],
    shell: false
  }]
})

export const createProcessListenerPolicy = () => ({
  access: 'sandboxed',
  executables: [{ executableId: 'echo', argumentBytes: 4096 }],
  shell: { access: 'none' },
  environment: { allowedNames: [], maxValueBytes: 1024 },
  mounts: [],
  network: { access: 'none' },
  limits: {
    maxConcurrentProcesses: 1,
    maxTotalProcesses: 4,
    maxProcessTreeDepth: 1,
    maxOpenPipes: 3,
    maxExecutionTimeMs: 5000,
    maxStdinBytes: 4096,
    maxStdoutBytes: 4096,
    maxStderrBytes: 4096,
    maxWritableRootfsBytes: 0
  }
})
