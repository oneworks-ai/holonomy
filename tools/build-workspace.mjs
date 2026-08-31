import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const buildRoot = resolve(root, '.build')

const run = spawnSync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.build.json'], {
  cwd: root,
  encoding: 'utf8',
  stdio: 'inherit'
})
if (run.status !== 0) process.exit(run.status ?? 1)

const copyTree = (source, destination) => {
  if (!existsSync(source)) return
  mkdirSync(dirname(destination), { recursive: true })
  cpSync(source, destination, { recursive: true })
}

rmSync(resolve(root, 'dist'), { force: true, recursive: true })
copyTree(resolve(buildRoot, 'src'), resolve(root, 'dist'))

const packages = [
  ['packages/holouv', 'packages/holouv/src'],
  ['packages/runtime', 'packages/runtime/src'],
  ['packages/capabilities/device', 'packages/capabilities/device/src'],
  ['packages/capabilities/fs', 'packages/capabilities/fs/src'],
  ['packages/capabilities/network', 'packages/capabilities/network/src'],
  ['packages/capabilities/process', 'packages/capabilities/process/src'],
  ['packages/capabilities/system', 'packages/capabilities/system/src'],
  ['packages/plugins/audit', 'packages/plugins/audit/src'],
  ['packages/plugins/permission', 'packages/plugins/permission/src']
]
for (const [packageRoot, sourceRoot] of packages) {
  const destination = resolve(root, packageRoot, 'dist')
  rmSync(destination, { force: true, recursive: true })
  copyTree(resolve(buildRoot, sourceRoot), destination)
}

const machineSource = resolve(root, 'packages/runtime/src/kernel/machine')
const machineDestinations = [
  resolve(root, 'packages/runtime/dist/kernel/machine'),
  resolve(root, 'dist/capability-runtime/machine')
]
for (const destination of machineDestinations) mkdirSync(destination, { recursive: true })
for (const entry of readdirSync(machineSource, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.json')) continue
  for (const destination of machineDestinations) {
    copyFileSync(resolve(machineSource, entry.name), resolve(destination, entry.name))
  }
}
rmSync(buildRoot, { force: true, recursive: true })
