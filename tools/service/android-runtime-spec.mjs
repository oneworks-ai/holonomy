export const createAndroidRuntimeSpec = (process, socketName, initialNetworkRuleSet) => ({
  argv: process.launch.argv ?? [],
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
  sandboxPolicy: process.sandboxPolicy
})
