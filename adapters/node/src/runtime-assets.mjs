import { readFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const RUNTIME_ROOT_URL = 'holonomy:///runtime/'
const BOOTSTRAP_URL = `${RUNTIME_ROOT_URL}bootstrap.mjs`
const DIST_ROOT = fileURLToPath(new URL('../../../dist/', import.meta.url))
const SOURCE_ROOT = fileURLToPath(new URL('../../../src/', import.meta.url))
const require = createRequire(import.meta.url)
const packageRuntimeRoot = name => {
  const compiled = dirname(require.resolve(name))
  return Object.freeze({ compiled, source: resolve(compiled, '..', 'src') })
}
const WORKSPACE_MODULE_ROOTS = Object.freeze([
  Object.freeze({
    ...packageRuntimeRoot('@holonomyjs/runtime'),
    prefix: 'packages/runtime/'
  }),
  ...['device', 'fs', 'network', 'process', 'system'].map(name =>
    Object.freeze({
      ...packageRuntimeRoot(`@holonomyjs/capability-${name}`),
      prefix: `packages/capabilities/${name}/`
    })
  ),
  ...['audit', 'permission'].map(name =>
    Object.freeze({
      ...packageRuntimeRoot(`@holonomyjs/plugin-${name}`),
      prefix: `packages/plugins/${name}/`
    })
  )
])
const ROOT_RUNTIME_ENTRIES = Object.freeze([
  'capability-runtime/guest-facades',
  'event-loop/index',
  'runtime-console/index',
  'runtime/index',
  'timers/index',
  'web-network/network-mock-router'
])
const ACORN_FILE = resolve(
  dirname(require.resolve('acorn/package.json')),
  'dist/acorn.mjs'
)
const CORDIS_FILE = require.resolve('cordis')
const COSMOKIT_FILE = resolve(
  dirname(createRequire(CORDIS_FILE).resolve('cosmokit/package.json')),
  'lib/index.mjs'
)
const BOOTSTRAP_FILE = fileURLToPath(new URL('./runtime-bootstrap.source.mjs', import.meta.url))
const WEB_STANDARDS_FILE = fileURLToPath(new URL('./runtime-web-standards.mjs', import.meta.url))
let ownedModulesPromise

const listJavaScript = async root => {
  const output = []
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const target = resolve(directory, entry.name)
      if (entry.isDirectory()) pending.push(target)
      else if (entry.isFile() && entry.name.endsWith('.js')) output.push(target)
    }
  }
  return output.sort()
}

const runtimeModule = async (file, url) => Object.freeze({ source: await readFile(file, 'utf8'), url })

const sourceRuntimeModules = async () => {
  const files = []
  const roots = WORKSPACE_MODULE_ROOTS.map(({ prefix, source }) => Object.freeze({ prefix, source }))
  try {
    for (const root of roots) await readdir(root.source)
    const pending = roots.map(root => Object.freeze({ directory: root.source, root }))
    for (const entry of ROOT_RUNTIME_ENTRIES) {
      files.push(
        Object.freeze({ file: resolve(SOURCE_ROOT, `${entry}.ts`), root: { prefix: '', source: SOURCE_ROOT } })
      )
    }
    while (pending.length > 0) {
      const { directory, root } = pending.pop()
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const target = resolve(directory, entry.name)
        if (entry.isDirectory()) pending.push(Object.freeze({ directory: target, root }))
        else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(Object.freeze({ file: target, root }))
      }
    }
  } catch {
    return undefined
  }
  const typescript = await import('typescript')
  return Promise.all(
    files.sort((left, right) => left.file.localeCompare(right.file)).map(async ({ file, root }) => {
      const source = await readFile(file, 'utf8')
      const output = typescript.transpileModule(source, {
        compilerOptions: {
          module: typescript.ModuleKind.ESNext,
          target: typescript.ScriptTarget.ESNext
        },
        fileName: file
      }).outputText
      const relativePath = relative(root.source, file).split(sep).join('/').replace(/\.ts$/u, '.js')
      return Object.freeze({ source: output, url: `${RUNTIME_ROOT_URL}modules/${root.prefix}${relativePath}` })
    })
  )
}

const loadOwnedModules = async () => {
  let compiled
  try {
    compiled = [
      ...ROOT_RUNTIME_ENTRIES.map(entry =>
        Object.freeze({
          file: resolve(DIST_ROOT, `${entry}.js`),
          prefix: '',
          root: DIST_ROOT
        })
      ),
      ...(await Promise.all(
        WORKSPACE_MODULE_ROOTS.map(async item =>
          (await listJavaScript(item.compiled)).map(file =>
            Object.freeze({
              file,
              prefix: item.prefix,
              root: item.compiled
            })
          )
        )
      )).flat()
    ]
  } catch {
    compiled = []
  }
  const sourceModules = compiled.length === 0 ? await sourceRuntimeModules() : undefined
  if (compiled.length === 0 && sourceModules == null) throw new Error('Holonomy Runtime assets are unavailable')
  const modules = sourceModules ??
    await Promise.all(
      compiled.map(({ file, prefix, root }) =>
        runtimeModule(file, `${RUNTIME_ROOT_URL}modules/${prefix}${relative(root, file).split(sep).join('/')}`)
      )
    )
  modules.push(await runtimeModule(ACORN_FILE, `${RUNTIME_ROOT_URL}vendor/acorn.mjs`))
  modules.push(await runtimeModule(CORDIS_FILE, `${RUNTIME_ROOT_URL}vendor/cordis.mjs`))
  modules.push(await runtimeModule(COSMOKIT_FILE, `${RUNTIME_ROOT_URL}vendor/cosmokit.mjs`))
  modules.push(await runtimeModule(WEB_STANDARDS_FILE, `${RUNTIME_ROOT_URL}runtime-web-standards.mjs`))
  modules.push(await runtimeModule(BOOTSTRAP_FILE, BOOTSTRAP_URL))
  return Object.freeze(modules)
}

const ownedModules = () => {
  ownedModulesPromise ??= loadOwnedModules().catch(error => {
    ownedModulesPromise = undefined
    throw error
  })
  return ownedModulesPromise
}

export async function prepareHolonomyNodeSession(input) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Invalid Node Runtime session')
  }
  if (Array.isArray(input.runtimeModules) && input.runtimeModules.length > 0) {
    throw new TypeError('Node adapter owns the internal Runtime module graph')
  }
  return {
    ...input,
    entryUrl: BOOTSTRAP_URL,
    runtimeModules: await ownedModules(),
    userEntryUrl: input.entryUrl
  }
}
