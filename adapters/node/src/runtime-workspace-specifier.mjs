const HOLO_WORKSPACE_PACKAGES = Object.freeze({
  '@holonomyjs/capability-device': 'packages/capabilities/device',
  '@holonomyjs/capability-fs': 'packages/capabilities/fs',
  '@holonomyjs/capability-network': 'packages/capabilities/network',
  '@holonomyjs/capability-process': 'packages/capabilities/process',
  '@holonomyjs/capability-system': 'packages/capabilities/system',
  '@holonomyjs/plugin-audit': 'packages/plugins/audit',
  '@holonomyjs/plugin-permission': 'packages/plugins/permission',
  '@holonomyjs/runtime': 'packages/runtime'
})

export const isTrustedRuntimePluginLibrary = specifier =>
  specifier === '@holonomyjs/plugin-audit' || specifier === '@holonomyjs/plugin-permission'

export const resolveRuntimeWorkspaceSpecifier = specifier => {
  const match = /^(@holonomyjs\/[a-z-]+)(?:\/(.+))?$/u.exec(specifier)
  if (match == null) return undefined
  const root = HOLO_WORKSPACE_PACKAGES[match[1]]
  if (root == null) return undefined
  const subpath = match[2]
  const entry = subpath == null || subpath === ''
    ? 'index.js'
    : subpath === 'app' || subpath === 'kernel'
    ? `${subpath}/index.js`
    : `${subpath}.js`
  return `holonomy:///runtime/modules/${root}/${entry}`
}
