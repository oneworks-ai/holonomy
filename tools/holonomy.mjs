#!/usr/bin/env node

import process from 'node:process'

import { failHolonomyCommand, parseHolonomyArgs } from './holonomy-cli-options.mjs'
import { readHolonomyDocumentation } from './holonomy-help.mjs'
import { runHolonomyRuntimeCommand } from './holonomy-managed-command.mjs'
import { parseAndRunHolonomyManagementCommand } from './holonomy-management-command.mjs'

const main = async () => {
  const arguments_ = process.argv.slice(2)
  const documentation = readHolonomyDocumentation(arguments_)
  if (documentation != null) {
    process.stdout.write(documentation)
    return
  }
  const managementResult = await parseAndRunHolonomyManagementCommand(arguments_, process)
  if (managementResult != null) return
  const abort = new AbortController()
  const interrupt = signal => abort.abort(signal)
  const interruptSignal = () => interrupt('SIGINT')
  const terminateSignal = () => interrupt('SIGTERM')
  process.once('SIGINT', interruptSignal)
  process.once('SIGTERM', terminateSignal)
  try {
    process.exitCode = await runHolonomyRuntimeCommand(parseHolonomyArgs(arguments_), process, {
      signal: abort.signal
    })
  } finally {
    process.off('SIGINT', interruptSignal)
    process.off('SIGTERM', terminateSignal)
  }
}

main().catch(error => failHolonomyCommand(error instanceof Error ? error.message : 'Holonomy command failed'))
