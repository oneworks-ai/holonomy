#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import process from 'node:process'

import { createHolonomyServiceLifecycleManager } from './lifecycle-manager.mjs'

const readTls = async environment => {
  const certPath = environment.HOLONOMY_SERVICE_TLS_CERT
  const keyPath = environment.HOLONOMY_SERVICE_TLS_KEY
  if (certPath == null && keyPath == null) return undefined
  if (certPath == null || keyPath == null) throw new Error('TLS certificate and key must be configured together')
  return { cert: await readFile(certPath), key: await readFile(keyPath) }
}

const main = async () => {
  const manager = createHolonomyServiceLifecycleManager({
    environment: process.env,
    service: {
      host: process.env.HOLONOMY_SERVICE_HOST ?? '127.0.0.1',
      port: Number(process.env.HOLONOMY_SERVICE_PORT ?? 0),
      tls: await readTls(process.env)
    }
  })
  const status = await manager.ensure()
  process.stdout.write(`${JSON.stringify(status)}\n`)
  if (status.reused) return
  const shutdown = () => void manager.stop({ drain: true }).finally(() => process.exit())
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Holonomy Service failed'}\n`)
  process.exitCode = 1
})
