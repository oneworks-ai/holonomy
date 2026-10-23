/* eslint-disable no-console -- Guest stdout is the Native corpus marker. */
/* eslint-disable antfu/no-top-level-await -- Actual Guest ESM app exercises asynchronous Cordis lifecycle. */
import assert from 'node:assert/strict'

import { Context, FiberState } from 'cordis'
import YAML from 'yaml'

const config = YAML.parse('name: example\ncount: 3\n')
const events = []
const plugin = {
  name: 'configured-plugin',
  Config: {
    '~standard': {
      version: 1,
      vendor: 'corpus',
      validate(value) {
        if (value.name !== 'example' || value.count !== 3) {
          return { issues: [{ message: 'invalid config' }] }
        }
        return { value: { ...value, label: `${value.name}:${value.count}` } }
      }
    }
  },
  apply(ctx, value) {
    events.push(`apply:${value.label}`)
    ctx.effect(() => {
      events.push('effect')
      return () => events.push('effect-disposed')
    })
    return () => events.push('plugin-disposed')
  }
}

const context = new Context()
const fiber = context.plugin(plugin, config)
await fiber
assert.equal(fiber.state, FiberState.ACTIVE)
assert.deepEqual(events, ['apply:example:3', 'effect'])
await fiber.dispose()
assert.equal(fiber.state, FiberState.DISPOSED)
assert.equal(events.includes('effect-disposed'), true)
assert.equal(events.includes('plugin-disposed'), true)
console.log('CORDIS_YAML_APP_OK')
