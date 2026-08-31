import { STORAGE_NATIVE_MODULE, STORAGE_OPERATION_VERSION } from './constants.js'

const partial = (notes: string) => Object.freeze({ notes, status: 'partial' as const })
const unsupported = (notes: string) => Object.freeze({ notes, status: 'unsupported' as const })

/** Static v1 contract; it does not advertise a provider as installed or self-tested. */
export const STORAGE_CAPABILITY_MATRIX = Object.freeze({
  api: Object.freeze({
    credentials: partial(
      'Provider-dependent: opaque handles expose only withBytes after install, self-test and conformance advertisement.'
    ),
    kv: partial(
      'Provider-dependent: authorized bounded binary KV requires install, self-test and conformance advertisement.'
    ),
    persistence: unsupported('v1 defines a provider contract, not a persistence implementation.'),
    secretEnumeration: unsupported('Credential names and material are never listed or serialized.'),
    sqlParser: unsupported('v1 transports authorized SQL text; it does not parse or rewrite SQL.'),
    sqlite: partial(
      'Provider-dependent: asynchronous bounded SQLite requires install, self-test and conformance advertisement.'
    ),
    sqliteSync: unsupported('v1 does not expose node:sqlite or synchronous database I/O.')
  }),
  bareV8: partial('Facade uses an injected NativeBridge only; provider availability remains host-dependent.'),
  contract: Object.freeze({
    module: STORAGE_NATIVE_MODULE,
    operationVersion: STORAGE_OPERATION_VERSION,
    requestModes: Object.freeze(['result'] as const)
  }),
  provider: Object.freeze({
    installedSupport: 'Static contract only; provider install, self-test and conformance determine availability.',
    reauthorizationRequired: true,
    resourceOwner: 'NativeBridge',
    transactions: 'Provider obligation: per-database FIFO, exclusive transaction, rollback on failure/cancel.'
  }),
  version: 1
})
