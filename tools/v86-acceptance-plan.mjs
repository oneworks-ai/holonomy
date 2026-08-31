const PHASES = Object.freeze({
  all: Object.freeze(['node', 'android', 'guest']),
  android: Object.freeze(['android']),
  guest: Object.freeze(['guest']),
  images: Object.freeze(['images']),
  node: Object.freeze(['node'])
})

export const V86_NODE_ACCEPTANCE_FILES_V1 = Object.freeze([
  'adapters/node/test/capability-process-v86-runtime.test.mjs',
  'adapters/node/test/capability-process-v86-security-runtime.test.mjs'
])

export const v86AcceptancePhasesV1 = command => {
  const phases = PHASES[command]
  if (phases == null) throw new TypeError('Invalid v86 acceptance command')
  return phases
}
