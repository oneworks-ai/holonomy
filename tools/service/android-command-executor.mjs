import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'

import { serviceError } from './errors.mjs'

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024
const TERMINATION_GRACE_MS = 1_000

export const executeAndroidCommand = async (file, args, options = {}) =>
  await new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(serviceError('service.unavailable', 'Android command was cancelled'))
      return
    }
    const child = (options.spawn ?? spawn)(file, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const chunks = []
    const errors = []
    let bytes = 0
    let settled = false
    let forceTermination
    let timeout
    let abort
    const settle = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abort)
      error == null ? resolve(value) : reject(error)
    }
    const terminate = error => {
      if (settled) return
      forceTermination = setTimeout(() => {
        if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL')
      }, options.terminationGraceMs ?? TERMINATION_GRACE_MS)
      forceTermination.unref?.()
      child.kill('SIGTERM')
      settle(error)
    }
    abort = () => {
      terminate(serviceError('service.unavailable', 'Android command was cancelled'))
    }
    timeout = setTimeout(() => {
      terminate(serviceError('service.unavailable', 'Android command timed out'))
    }, options.timeoutMs ?? 30_000)
    options.signal?.addEventListener('abort', abort, { once: true })
    const collect = target => chunk => {
      bytes += chunk.byteLength
      if (bytes > (options.maxBytes ?? MAX_OUTPUT_BYTES)) {
        terminate(serviceError('service.limit_exceeded', 'Android command output exceeds its limit'))
      } else target.push(chunk)
    }
    child.stdout.on('data', collect(chunks))
    child.stderr.on('data', collect(errors))
    child.once('error', () => settle(serviceError('service.unavailable', 'Android command failed')))
    child.once('exit', code => {
      clearTimeout(forceTermination)
      if (bytes > (options.maxBytes ?? MAX_OUTPUT_BYTES)) {
        settle(serviceError('service.limit_exceeded', 'Android command output exceeds its limit'))
      } else if (code !== 0) settle(serviceError('service.unavailable', 'Android command failed'))
      else settle(undefined, Buffer.concat(chunks).toString('utf8'))
    })
    if (options.input != null) child.stdin.end(options.input)
    else child.stdin.end()
  })
