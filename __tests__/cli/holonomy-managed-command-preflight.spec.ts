import { expect, it } from 'vitest'

import { parseHolonomyArgs } from '../../tools/holonomy-cli-options.mjs'
import { runHolonomyRuntimeCommand } from '../../tools/holonomy-managed-command.mjs'

it('rejects failed launch preflight before creating or starting a Service client', async () => {
  let clientCalls = 0
  let serviceStarts = 0
  const parsed = parseHolonomyArgs(['run', '--target', 'native', 'entry.mjs'])
  await expect(runHolonomyRuntimeCommand(parsed, {
    stderr: { write: () => undefined },
    stdout: { write: () => undefined }
  }, {
    createClient: () => {
      clientCalls += 1
      throw new Error('Service client should not be created')
    },
    ensureService: async () => {
      serviceStarts += 1
    },
    prepareLaunch: async () => {
      throw new Error('Native source preflight failed')
    }
  })).rejects.toThrow('Native source preflight failed')
  expect(clientCalls).toBe(0)
  expect(serviceStarts).toBe(0)
})
