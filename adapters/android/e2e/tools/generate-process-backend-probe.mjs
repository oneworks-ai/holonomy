import { Buffer } from 'node:buffer'

const probeModuleHex = '0061736d010000000105016000017f030201000707010372756e00000a06010400412a0b'

export const generateProcessBackendProbe = () => ({
  bytes: Buffer.from(probeModuleHex, 'hex'),
  path: 'runtime/process-backends/probe-answer-v1.wasm',
  source: 'generated:process-backend-probe-v1'
})
