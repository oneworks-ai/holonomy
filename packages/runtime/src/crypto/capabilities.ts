import { freeze } from './intrinsics.js'
import { DEFAULT_CRYPTO_PRIMITIVE_LIMITS } from './primitive-port.js'
import type { CryptoPrimitiveLimits } from './types.js'

export interface CryptoCapabilityDescriptor {
  readonly constraints?: Readonly<Record<string, boolean | number | string>>
  readonly features: readonly string[]
  readonly id: 'host.crypto' | 'node.crypto' | 'web.crypto'
  readonly mappedTo?: 'host.crypto'
  readonly provider: 'host-mapped' | 'supported'
  readonly version: '1.0.0'
}

const HOST_CRYPTO_FEATURES = freeze([
  'host.crypto.aes-256-gcm',
  'host.crypto.hash.sha1',
  'host.crypto.hash.sha256',
  'host.crypto.hmac.sha256',
  'host.crypto.random-bytes',
  'host.crypto.random-uuid',
  'host.crypto.timing-safe-equal'
])

const NODE_CRYPTO_FEATURES = freeze([
  'node.crypto.aes-256-gcm',
  'node.crypto.create-hash.sha1',
  'node.crypto.create-hash.sha256',
  'node.crypto.create-hmac.sha256',
  'node.crypto.random-bytes-sync',
  'node.crypto.random-uuid',
  'node.crypto.timing-safe-equal'
])

const WEB_CRYPTO_FEATURES = freeze([
  'web.crypto.get-random-values',
  'web.crypto.random-uuid'
])

/** Static support contract. It is not an advertisement that a platform provider is wired. */
export const CRYPTO_CAPABILITY_MATRIX = freeze({
  capabilityVersion: '1.0.0' as const,
  hostCrypto: freeze({
    constraints: freeze({
      'host.crypto.aad.max-bytes': DEFAULT_CRYPTO_PRIMITIVE_LIMITS.maxAadBytes,
      'host.crypto.compare.max-bytes': DEFAULT_CRYPTO_PRIMITIVE_LIMITS.maxCompareBytes,
      'host.crypto.context.max-bytes': DEFAULT_CRYPTO_PRIMITIVE_LIMITS.maxContextBytes,
      'host.crypto.context.max-count': DEFAULT_CRYPTO_PRIMITIVE_LIMITS.maxContexts,
      'host.crypto.in-flight.max-bytes': DEFAULT_CRYPTO_PRIMITIVE_LIMITS.maxInFlightContextBytes,
      'host.crypto.random.max-bytes': DEFAULT_CRYPTO_PRIMITIVE_LIMITS.maxRandomBytesPerCall,
      'host.crypto.update.max-bytes': DEFAULT_CRYPTO_PRIMITIVE_LIMITS.maxUpdateBytesPerCall,
      'host.crypto.provider.async-rejection-observer-owner': 'provider',
      'host.crypto.provider-install-self-test-required': true,
      'host.crypto.provider.strict-sync-return': true,
      'host.crypto.sync-engine-internal': true
    }),
    features: HOST_CRYPTO_FEATURES,
    id: 'host.crypto' as const,
    later: freeze([
      'host.crypto.cipher.other',
      'host.crypto.ecdsa',
      'host.crypto.pbkdf2',
      'host.crypto.rsa',
      'host.crypto.web-subtle'
    ])
  }),
  nodeCrypto: freeze({
    constraints: freeze({
      'node.crypto.aes-256-gcm.auth-tag-bytes': 16,
      'node.crypto.aes-256-gcm.iv-bytes': 12,
      'node.crypto.aes-256-gcm.key-bytes': 32,
      'node.crypto.aes-256-gcm.update-chunk-timing': 'provider-buffered',
      'node.crypto.digest-encodings': 'raw,hex,base64,base64url',
      'node.crypto.sync-only': true
    }),
    features: NODE_CRYPTO_FEATURES,
    id: 'node.crypto' as const,
    later: freeze([
      'node.crypto.cipher.other',
      'node.crypto.ecdsa',
      'node.crypto.pbkdf2',
      'node.crypto.rsa'
    ]),
    mappedTo: 'host.crypto' as const
  }),
  webCrypto: freeze({
    constraints: freeze({
      'web.crypto.get-random-values.max-bytes': 65_536,
      'web.crypto.subtle': false
    }),
    features: WEB_CRYPTO_FEATURES,
    id: 'web.crypto' as const,
    later: freeze([
      'web.crypto.ecdsa',
      'web.crypto.pbkdf2',
      'web.crypto.rsa',
      'web.crypto.subtle'
    ]),
    mappedTo: 'host.crypto' as const
  })
})

/** Internal: installation code calls this only after provider self-test succeeds. */
export const createInstalledCryptoCapabilityDescriptors = (
  limits: CryptoPrimitiveLimits
): readonly CryptoCapabilityDescriptor[] =>
  freeze([
    freeze({
      constraints: freeze({
        'host.crypto.aad.max-bytes': limits.maxAadBytes,
        'host.crypto.compare.max-bytes': limits.maxCompareBytes,
        'host.crypto.context.max-bytes': limits.maxContextBytes,
        'host.crypto.context.max-count': limits.maxContexts,
        'host.crypto.in-flight.max-bytes': limits.maxInFlightContextBytes,
        'host.crypto.random.max-bytes': limits.maxRandomBytesPerCall,
        'host.crypto.update.max-bytes': limits.maxUpdateBytesPerCall,
        'host.crypto.provider.async-rejection-observer-owner': 'provider',
        'host.crypto.provider-install-self-test-required': true,
        'host.crypto.provider.strict-sync-return': true,
        'host.crypto.sync-engine-internal': true
      }),
      features: HOST_CRYPTO_FEATURES,
      id: 'host.crypto' as const,
      provider: 'supported' as const,
      version: '1.0.0' as const
    }),
    freeze({
      constraints: freeze({
        'node.crypto.aes-256-gcm.auth-tag-bytes': 16,
        'node.crypto.aes-256-gcm.iv-bytes': 12,
        'node.crypto.aes-256-gcm.key-bytes': 32,
        'node.crypto.aes-256-gcm.update-chunk-timing': 'provider-buffered',
        'node.crypto.digest-encodings': 'raw,hex,base64,base64url',
        'node.crypto.random.max-bytes': limits.maxRandomBytesPerCall,
        'node.crypto.sync-only': true
      }),
      features: NODE_CRYPTO_FEATURES,
      id: 'node.crypto' as const,
      mappedTo: 'host.crypto' as const,
      provider: 'host-mapped' as const,
      version: '1.0.0' as const
    }),
    freeze({
      constraints: freeze({
        'web.crypto.get-random-values.max-bytes': 65_536,
        'web.crypto.subtle': false
      }),
      features: WEB_CRYPTO_FEATURES,
      id: 'web.crypto' as const,
      mappedTo: 'host.crypto' as const,
      provider: 'host-mapped' as const,
      version: '1.0.0' as const
    })
  ])
