export const TIMER_CAPABILITY_MATRIX = Object.freeze({
  globals: Object.freeze({
    clearImmediate: 'supported',
    clearInterval: 'supported',
    clearTimeout: 'supported',
    setImmediate: 'supported',
    setInterval: 'supported',
    setTimeout: 'supported'
  }),
  lifecycle: 'native monotonic scheduler with generation-bound runtime-thread delivery',
  module: 'node:timers',
  status: 'supported'
})
