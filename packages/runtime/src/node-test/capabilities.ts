export const NODE_TEST_CAPABILITY_MATRIX = Object.freeze({
  assertions: 'node:assert/strict common subset',
  hooks: Object.freeze(['after', 'afterEach', 'before', 'beforeEach']),
  platformExtension: 'describe.holonomy.<platform> and it.holonomy.<platform>',
  reporting: Object.freeze(['json-summary', 'tap']),
  runner: 'sequential JavaScript runner',
  status: 'partial'
})
