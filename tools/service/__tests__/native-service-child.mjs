import { spawn } from 'node:child_process'
import { join } from 'node:path'

import { createNativeRuntimeAdapter } from '../native-target-adapter.mjs'
import { createHolonomyService } from '../server.mjs'

const [, , home, executablePath] = process.argv
const stateDirectory = join(home, 'state')
const nativeAdapter = createNativeRuntimeAdapter({
  executablePath,
  stateDirectory,
  spawn(file, args, options) {
    const child = spawn(file, args, options)
    process.send?.({ args, pid: child.pid, type: 'native-child' })
    return child
  }
})
const service = createHolonomyService({
  nativeAdapter,
  port: 0,
  stateDirectory,
  token: 'native-test-token-that-is-at-least-thirty-two-bytes'
})
await service.start()
process.send?.({ baseUrl: service.baseUrl, type: 'ready' })
