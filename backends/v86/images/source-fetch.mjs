import { sha256 } from './image-contract.mjs'

export const parseImageSourceMirrorV1 = value => {
  if (value == null) return null
  const mirror = new URL(value)
  if (
    mirror.protocol !== 'https:' || mirror.username || mirror.password ||
    mirror.pathname !== '/' || mirror.search || mirror.hash
  ) throw new TypeError('HOLO_V86_SOURCE_MIRROR must be an HTTPS origin without credentials or path')
  return mirror
}

export const fetchPinnedImageBytesV1 = async ({ expected, url, mirror, transport = fetch }) => {
  const source = new URL(url)
  if (
    source.protocol !== 'https:' || source.username || source.password || source.search || source.hash ||
    !source.pathname.startsWith('/alpine/') || source.pathname.startsWith('//')
  ) {
    throw new TypeError('Pinned image source must be an HTTPS URL without credentials or query')
  }
  const location = mirror == null ? source.href : new URL(source.pathname, mirror).href
  const response = await transport(location, { redirect: 'manual' })
  if (!response.ok || response.url !== location) {
    throw new Error(`v86 image download failed: ${location}`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (sha256(bytes) !== expected) throw new Error(`v86 image digest mismatch: ${location}`)
  return bytes
}
