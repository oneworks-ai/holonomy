export const wireNodeRuntimeSessionV1 = session => {
  const output = {
    ...session,
    runtimeModules: session.runtimeModules.map(({ source, url }) => ({ source, url })),
    userModules: session.userModules.map(({ source, url }) => ({ source, url }))
  }
  if (session.sandboxPolicy.network.access === 'none') delete output.networkRules
  return output
}
