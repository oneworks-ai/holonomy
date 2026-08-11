export const CONSOLE_CAPABILITY_MATRIX = Object.freeze({
  formatting: '64 KiB accessor-free primitive and object-tag formatting with host detail redaction',
  globals: Object.freeze({
    debug: 'supported',
    error: 'supported',
    info: 'supported',
    log: 'supported',
    warn: 'supported'
  }),
  module: 'node:console',
  sinks: Object.freeze(['process-stdout', 'process-stderr']),
  status: 'partial'
})
