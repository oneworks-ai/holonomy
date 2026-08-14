export const createAndroidRuntimeSpec = (process, socketName, initialNetworkRuleSet, capabilityRuntime) => ({
  argv: process.launch.argv ?? [],
  ...(capabilityRuntime == null ? {} : { capabilityRuntime }),
  entryUrl: process.entryUrl,
  env: process.launch.env ?? {},
  initialControls: initialNetworkRuleSet == null
    ? []
    : [{ operation: 'network.rules.replace', value: initialNetworkRuleSet }],
  ...(socketName == null ? {} : {
    inspector: { breakBeforeEntry: process.inspectorMode === 'break', socketName }
  }),
  isolation: process.isolation === 'isolatedProcess' ? 'isolatedProcess' : 'runtime',
  modules: process.launch.modules ?? [],
  ...(process.runtimePlugins == null ? {} : { runtimePlugins: process.runtimePlugins }),
  sandboxPolicy: process.sandboxPolicy
})
