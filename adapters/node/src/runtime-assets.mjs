import { readFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const RUNTIME_ROOT_URL = 'holonomy:///runtime/'
const BOOTSTRAP_URL = `${RUNTIME_ROOT_URL}bootstrap.mjs`
const DIST_ROOT = fileURLToPath(new URL('../../../dist/', import.meta.url))
const SOURCE_ROOT = fileURLToPath(new URL('../../../src/', import.meta.url))
const ACORN_FILE = resolve(
  dirname(createRequire(import.meta.url).resolve('acorn/package.json')),
  'dist/acorn.mjs'
)
const CORDIS_FILE = createRequire(import.meta.url).resolve('cordis')
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
  try {
    await readdir(SOURCE_ROOT)
    const pending = [SOURCE_ROOT]
    while (pending.length > 0) {
      const directory = pending.pop()
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const target = resolve(directory, entry.name)
        if (entry.isDirectory()) pending.push(target)
        else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(target)
      }
    }
  } catch {
    return undefined
  }
  const typescript = await import('typescript')
  return Promise.all(
    files.sort().map(async file => {
      const source = await readFile(file, 'utf8')
      const output = typescript.transpileModule(source, {
        compilerOptions: {
          module: typescript.ModuleKind.ESNext,
          target: typescript.ScriptTarget.ESNext
        },
        fileName: file
      }).outputText
      const relativePath = relative(SOURCE_ROOT, file).split(sep).join('/').replace(/\.ts$/u, '.js')
      return Object.freeze({ source: output, url: `${RUNTIME_ROOT_URL}modules/${relativePath}` })
    })
  )
}

const loadOwnedModules = async () => {
  let compiled
  try {
    compiled = await listJavaScript(DIST_ROOT)
  } catch {
    compiled = []
  }
  const sourceModules = compiled.length === 0 ? await sourceRuntimeModules() : undefined
  if (compiled.length === 0 && sourceModules == null) throw new Error('Holonomy Runtime assets are unavailable')
  const modules = sourceModules ??
    await Promise.all(
      compiled.map(file =>
        runtimeModule(file, `${RUNTIME_ROOT_URL}modules/${relative(DIST_ROOT, file).split(sep).join('/')}`)
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
