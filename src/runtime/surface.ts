import { CHILD_PROCESS_CAPABILITY_MATRIX } from '../child-process/index.js'
import { CRYPTO_CAPABILITY_MATRIX } from '../crypto/index.js'
import { GIT_CAPABILITY_MATRIX } from '../git/index.js'
import { HTTP_SERVER_CAPABILITY_MATRIX } from '../http-server/index.js'
import { NODE_CORE_CAPABILITY_MATRIX } from '../node-compat/index.js'
import { FS_CAPABILITY_MATRIX } from '../node-fs/index.js'
import { NODE_TEST_CAPABILITY_MATRIX } from '../node-test/index.js'
import { CONSOLE_CAPABILITY_MATRIX } from '../runtime-console/index.js'
import { STORAGE_CAPABILITY_MATRIX } from '../storage/index.js'
import { STREAM_CAPABILITY_MATRIX, createWebStreamsGlobals } from '../streams/index.js'
import { TIMER_CAPABILITY_MATRIX } from '../timers/index.js'
import { WEB_NETWORK_CAPABILITY_MATRIX } from '../web-network/index.js'
import { runtimeComposerError } from './errors.js'
import { createRuntimeRecord, defineRuntimeData, freezeRuntimeValue, getRuntimeOwnDescriptor } from './intrinsics.js'

import type { InstalledCryptoRuntime } from '../crypto/index.js'
import type { InstalledRuntimeConsole } from '../runtime-console/index.js'
import type { RuntimeTimers } from '../timers/index.js'

const KEYS = Object.keys

export const createRuntimeGlobals = (
  crypto?: InstalledCryptoRuntime,
  network?: Record<string, object>,
  console?: InstalledRuntimeConsole,
  timers?: RuntimeTimers
) => {
  const globals = createRuntimeRecord() as Record<string, object>
  const streams = createWebStreamsGlobals()
  const streamNames = KEYS(streams)
  for (let index = 0; index < streamNames.length; index += 1) {
    const name = streamNames[index] as string
    const descriptor = getRuntimeOwnDescriptor(streams, name)
    if (descriptor == null || !('value' in descriptor)) throw runtimeComposerError('runtime_composer.invalid_options')
    defineRuntimeData(globals, name, descriptor.value)
  }
  if (network != null) {
    const names = KEYS(network)
    for (let index = 0; index < names.length; index += 1) {
      const name = names[index] as string
      const descriptor = getRuntimeOwnDescriptor(network, name)
      if (descriptor == null || !('value' in descriptor)) throw runtimeComposerError('runtime_composer.invalid_options')
      defineRuntimeData(globals, name, descriptor.value)
    }
  }
  if (crypto != null) defineRuntimeData(globals, 'crypto', crypto.installWebCrypto({}) as unknown as object)
  if (console != null) defineRuntimeData(globals, 'console', console.global)
  if (timers != null) {
    defineRuntimeData(globals, 'clearInterval', timers.globals.clearInterval)
    defineRuntimeData(globals, 'clearTimeout', timers.globals.clearTimeout)
    defineRuntimeData(globals, 'setInterval', timers.globals.setInterval)
    defineRuntimeData(globals, 'setTimeout', timers.globals.setTimeout)
  }
  return freezeRuntimeValue(globals)
}

const status = (installed: boolean, matrix: unknown) =>
  freezeRuntimeValue({ installed, matrix, status: installed ? 'installed' : 'unsupported' })

export const createRuntimeCapabilities = (
  input: {
    readonly crypto?: InstalledCryptoRuntime
    readonly console: boolean
    readonly fs: boolean
    readonly git: boolean
    readonly httpServer: boolean
    readonly network: boolean
    readonly storage: boolean
    readonly timers: boolean
  }
) =>
  freezeRuntimeValue({
    'child-process': status(input.git, CHILD_PROCESS_CAPABILITY_MATRIX),
    console: status(input.console, CONSOLE_CAPABILITY_MATRIX),
    crypto: input.crypto == null
      ? status(false, CRYPTO_CAPABILITY_MATRIX)
      : freezeRuntimeValue({
        descriptors: input.crypto.capabilityDescriptors,
        installed: true,
        matrix: CRYPTO_CAPABILITY_MATRIX,
        status: 'installed'
      }),
    fs: status(input.fs, FS_CAPABILITY_MATRIX),
    git: status(input.git, GIT_CAPABILITY_MATRIX),
    'http-server': status(input.httpServer, HTTP_SERVER_CAPABILITY_MATRIX),
    network: status(input.network, WEB_NETWORK_CAPABILITY_MATRIX),
    'node-core': status(true, NODE_CORE_CAPABILITY_MATRIX),
    'node-test': status(true, NODE_TEST_CAPABILITY_MATRIX),
    storage: status(input.storage, STORAGE_CAPABILITY_MATRIX),
    streams: status(true, STREAM_CAPABILITY_MATRIX),
    timers: status(input.timers, TIMER_CAPABILITY_MATRIX)
  })
