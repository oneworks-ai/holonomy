#!/usr/bin/env node

import process from 'node:process'

import { parseAndRunHolonomyManagementCommand } from './holonomy-management-command.mjs'

const usage = `The android:devtools compatibility command now uses managed Runtime processes.

Usage:
  pnpm android:devtools status
  pnpm android:devtools start --process PROCESS_ID
  pnpm android:devtools electron --process PROCESS_ID
  pnpm android:devtools logs --process PROCESS_ID
  pnpm android:devtools stop --process PROCESS_ID

Prefer: holonomy process inspect PROCESS_ID --devtools`

const parse = input => {
  const arguments_ = [...input]
  const action = arguments_.shift() ?? 'status'
  let processId
  while (arguments_.length > 0) {
    const argument = arguments_.shift()
    if (argument === '--process') processId = arguments_.shift()
    else if (argument === '--help' || argument === '-h') return { action: 'help' }
    else throw new Error(`Unsupported legacy option: ${argument}`)
  }
  return { action, processId }
}

const main = async () => {
  const input = parse(process.argv.slice(2))
  if (input.action === 'help') return process.stdout.write(`${usage}\n`)
  if (input.action === 'probe') {
    throw new Error('Legacy arbitrary probes are unsupported; use a process-scoped Inspector lease')
  }
  if (input.action === 'status' && input.processId == null) {
    await parseAndRunHolonomyManagementCommand(['process', 'list'], process)
    return
  }
  if (input.processId == null) throw new Error(`${input.action} requires --process PROCESS_ID`)
  const mapped = input.action === 'start' || input.action === 'electron'
    ? ['process', 'inspect', input.processId, '--devtools']
    : input.action === 'logs'
    ? ['process', 'logs', input.processId]
    : input.action === 'stop'
    ? ['process', 'stop', input.processId]
    : input.action === 'status'
    ? ['process', 'show', input.processId]
    : undefined
  if (mapped == null) throw new Error(`Unknown android:devtools command: ${input.action}`)
  await parseAndRunHolonomyManagementCommand(mapped, process)
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Holonomy DevTools command failed'}\n`)
  process.exitCode = 1
})
