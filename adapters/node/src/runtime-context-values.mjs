export function createContextValue(runtimeContext, value) {
  return runtimeContext.controls.parseFrozen(JSON.stringify(value))
}

export function drainRuntimeLogs(runtimeContext) {
  return runtimeContext.controls.drain().map(record => ({ level: record.level, text: record.text }))
}
