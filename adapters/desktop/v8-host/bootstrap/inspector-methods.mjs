/** Exact Native Inspector method -> Policy bit / Gate entry / source availability. */
export const NATIVE_INSPECTOR_METHODS = Object.freeze({
  'Debugger.evaluateOnCallFrame': Object.freeze(['evaluate', 'inspectorEvaluate', true]),
  'Debugger.setScriptSource': Object.freeze(['setScriptSource', 'debuggerSetScriptSource', true]),
  'Runtime.callFunctionOn': Object.freeze(['callFunctionOn', 'inspectorCallFunction', true]),
  'Runtime.compileScript': Object.freeze(['compileScript', 'inspectorCompile', true]),
  'Runtime.evaluate': Object.freeze(['evaluate', 'inspectorEvaluate', true]),
  'Runtime.runScript': Object.freeze(['runScript', 'inspectorRunScript', false])
})
