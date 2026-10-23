/* eslint-disable antfu/no-top-level-await, no-console -- Delivered Guest example intentionally exercises both APIs. */
import { spawn } from 'node:child_process'

const child = spawn('cat', [], { stdio: ['pipe', 'pipe', 'pipe'] })
let stdout = ''
let stderr = ''
child.stdout.on('data', value => {
  stdout += new TextDecoder().decode(value)
})
child.stderr.on('data', value => {
  stderr += new TextDecoder().decode(value)
})
child.stdin.write('V86_NATIVE_PROCESS_ECHO')
child.stdin.end()
const [code, signal] = await new Promise(resolve => child.once('close', (...args) => resolve(args)))
if (code !== 0 || signal !== null || stdout !== 'V86_NATIVE_PROCESS_ECHO' || stderr !== '') {
  throw new Error('v86 cat mismatch')
}
console.log('V86_NATIVE_PROCESS_OK')
