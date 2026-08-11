import { normalizeResolvedAddress } from './network-validation.mjs'

const dnsError = code => Object.assign(new Error(`Node network ${code}`), { code })

export async function resolvePinnedAddress({ authority, decision, hostname, request, resolve }) {
  let timer
  let onAbort
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(dnsError('aborted'))
    request.signal?.addEventListener('abort', onAbort, { once: true })
  })
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => reject(dnsError('dns_failed')), 10_000)
  })
  let results
  try {
    results = await Promise.race([
      Promise.resolve().then(() => resolve(hostname, { all: true, verbatim: true })),
      aborted,
      timedOut
    ])
  } catch (error) {
    if (error?.code === 'aborted') throw error
    throw dnsError('dns_failed')
  } finally {
    clearTimeout(timer)
    request.signal?.removeEventListener('abort', onAbort)
  }
  if (!Array.isArray(results) || results.length === 0 || results.length > 32) throw dnsError('dns_failed')
  const addresses = results.map(normalizeResolvedAddress)
  for (const address of addresses) authority.authorizeAddress({ ...address, decision, url: request.url })
  return addresses[0]
}
