import { createAndroidRuntimeHost } from './runtime-host.mjs'

const host = globalThis.__oneworksAndroidHost
if (host == null) throw new Error('Android host is unavailable')
delete globalThis.__oneworksAndroidHost
createAndroidRuntimeHost(host)
