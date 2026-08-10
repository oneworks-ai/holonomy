import { join } from 'node:path'

import defaultPlugin from '@fixture/f1-runtime'
import cjsPlugin, { activatePlugin as cjsActivatePlugin } from '@fixture/f1-runtime/cjs'
import { activatePlugin as namedActivatePlugin } from '@fixture/f1-runtime/named'

import { cycleA } from './cycle-a.mjs'
import { loadRuntimeDynamic } from './runtime-dynamic.mjs'

export { cjsActivatePlugin, cjsPlugin, cycleA, defaultPlugin, loadRuntimeDynamic, namedActivatePlugin }

const fakeImportPattern = /import\(['"]ignored\.mjs/
// import './also-ignored.mjs'

export const resourceUrl = new URL('./resource.txt', import.meta.url)

export const loadDynamic = () => import('./dynamic.mjs?revision=f1')

export function activatePlugin(context) {
  return { context, fakeImportPattern, joined: join('f1', 'plugin') }
}
