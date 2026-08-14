import process from 'node:process'

import { verifyV86KernelConfigFileV1 } from './kernel-config.mjs'

const main = async () => {
  const [configPath] = process.argv.slice(2)
  if (configPath == null) throw new TypeError('Usage: node verify-kernel-config.mjs <linux-.config>')
  const result = await verifyV86KernelConfigFileV1(configPath)
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

void main()
