import process from 'node:process'

export const createRuntimeConfiguration = session =>
  JSON.stringify({
    moduleRootUrl: session.moduleRootUrl,
    networkRules: session.networkRules,
    nodeCore: {
      appBaseUrl: 'app://runtime/',
      os: {
        arch: process.arch,
        homedir: '/runtime/home',
        hostname: 'runtime',
        identityPolicy: 'synthetic',
        platform: 'node',
        release: process.versions.node,
        tmpdir: '/runtime/tmp',
        type: 'Node',
        userInfo: { gid: 1, homedir: '/runtime/home', shell: null, uid: 1, username: 'runtime' }
      },
      process: {
        arch: process.arch,
        argv: session.argv,
        cwd: '/runtime',
        env: session.env,
        execPath: '/runtime/holonomy',
        pid: 1,
        platform: 'node',
        versions: { node: process.versions.node }
      },
      virtualRoot: '/runtime'
    },
    sandboxPlan: session.sandboxPlan,
    pluginGraphRevision: session.pluginGraphRevision,
    runtimePlugins: session.runtimePlugins.map(plugin => ({
      bundleSha256: plugin.bundleSha256,
      config: plugin.config,
      entryUrl: plugin.entryUrl,
      exportName: plugin.exportName,
      instanceId: plugin.instanceId
    })),
    userEntryUrl: session.userEntryUrl
  })
