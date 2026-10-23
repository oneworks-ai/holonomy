import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// The caller owns the temporary project and its cleanup. Every source file is
// ordinary on-disk input for the real Native source helper and public CLI.
export const createNativeHostGraphFixture = async (projectRoot, placement = 'package') => {
  if (placement !== 'package' && placement !== 'local') {
    throw new TypeError('Native Host graph fixture placement is invalid')
  }
  await mkdir(projectRoot, { recursive: true })
  const nodeModules = join(projectRoot, 'node_modules')
  const dependency = join(nodeModules, '.pnpm', 'dep@1', 'node_modules', 'dep')
  await mkdir(dependency, { recursive: true })
  await writeFile(
    join(dependency, 'package.json'),
    JSON.stringify({
      name: 'dep',
      type: 'module',
      exports: { '.': { import: './index.mjs' } },
      imports: { '#token': './token.mjs' }
    })
  )
  await writeFile(
    join(dependency, 'index.mjs'),
    "import {token} from '#token'; export {token}; export const singleton = {}\n"
  )
  await writeFile(join(dependency, 'token.mjs'), "export const token = 'PACKAGE_GRAPH_V2_OK'\n")
  await symlink('.pnpm/dep@1/node_modules/dep', join(nodeModules, 'dep'))
  await symlink('.pnpm/dep@1/node_modules/dep', join(nodeModules, 'dep-alias'))

  const gate = placement === 'package'
    ? join(nodeModules, '.pnpm', 'host-gate@1', 'node_modules', 'host-gate')
    : join(projectRoot, 'host')
  await mkdir(gate, { recursive: true })
  const gateEntry = join(gate, 'gate.mjs')
  await writeFile(
    gateEntry,
    [
      "import * as first from 'dep'",
      "import * as second from 'dep-alias'",
      "if (first !== second || first.token !== 'PACKAGE_GRAPH_V2_OK') throw Error('Host package alias is not singleton')",
      'export default function gate() {}',
      ''
    ].join('\n')
  )
  if (placement === 'package') {
    await writeFile(
      join(gate, 'package.json'),
      JSON.stringify({
        name: 'host-gate',
        type: 'module',
        holo: { kind: 'runtime-plugin', apiVersion: 1, entry: './gate.mjs' }
      })
    )
    await symlink('.pnpm/host-gate@1/node_modules/host-gate', join(nodeModules, 'host-gate'))
  } else {
    await writeFile(
      join(projectRoot, 'package.json'),
      JSON.stringify({ privateMarker: 'HOST_SHARED_METADATA_PRIVATE_FIELD', type: 'module' })
    )
  }
  const configPath = join(projectRoot, 'holo.config.json')
  await writeFile(
    configPath,
    JSON.stringify({
      plugins: [{ id: 'graph', use: placement === 'package' ? 'host-gate' : './host/gate.mjs' }]
    })
  )
  const guestEntry = join(projectRoot, 'index.js')
  await writeFile(
    guestEntry,
    placement === 'local'
      ? "console.log('GUEST_INDEX_JS_OK'); export {}\n"
      : "console.log('GUEST_INDEX_JS_OK')\n"
  )
  return Object.freeze({ configPath, dependency, gateEntry, guestEntry, placement, projectRoot })
}
