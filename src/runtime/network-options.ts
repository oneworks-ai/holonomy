import { runtimeComposerError } from './errors.js'
import { snapshotOptionalRecord, snapshotRecord } from './intrinsics.js'
import { snapshotNetworkAuthority } from './options.js'

import type { WebNetworkRuntimeOptions } from '../web-network/index.js'

type PreparedNetworkOptions = Omit<WebNetworkRuntimeOptions, 'bridge'>

export const prepareRuntimeNetworkOptions = (input: unknown, principal: string): PreparedNetworkOptions => {
  const item = snapshotRecord(input, [
    'authority',
    'constructors',
    'diagnostics',
    'diagnosticsBodyLimitBytes',
    'diagnosticsNow',
    'principal'
  ], ['authority', 'principal'])
  if (item.principal !== principal) throw runtimeComposerError('runtime_composer.principal_mismatch')
  const constructors = snapshotOptionalRecord(item.constructors, ['AbortController', 'AbortSignal'])
  const diagnostics = snapshotOptionalRecord(item.diagnostics, ['emit'])
  if (diagnostics !== undefined && typeof diagnostics.emit !== 'function') {
    throw runtimeComposerError('runtime_composer.invalid_options')
  }
  if (item.diagnosticsNow !== undefined && typeof item.diagnosticsNow !== 'function') {
    throw runtimeComposerError('runtime_composer.invalid_options')
  }
  if (
    item.diagnosticsBodyLimitBytes !== undefined &&
    (!Number.isSafeInteger(item.diagnosticsBodyLimitBytes) ||
      (item.diagnosticsBodyLimitBytes as number) < 0 ||
      (item.diagnosticsBodyLimitBytes as number) > 16 * 1024 * 1024)
  ) throw runtimeComposerError('runtime_composer.invalid_options')
  return {
    authority: snapshotNetworkAuthority(item.authority) as never,
    ...(constructors === undefined ? {} : { constructors: constructors as never }),
    ...(diagnostics === undefined ? {} : { diagnostics: diagnostics as never }),
    ...(item.diagnosticsBodyLimitBytes === undefined
      ? {}
      : { diagnosticsBodyLimitBytes: item.diagnosticsBodyLimitBytes as number }),
    ...(item.diagnosticsNow === undefined ? {} : { diagnosticsNow: item.diagnosticsNow as () => number })
  }
}
