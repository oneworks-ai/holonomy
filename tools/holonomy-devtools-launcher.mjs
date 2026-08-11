import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

export const resolveHolonomyElectronExecutable = () => {
  try {
    const executable = require('electron')
    if (typeof executable === 'string' && existsSync(executable)) return executable
  } catch {
    // Electron is an optional dependency so headless CLI installs remain usable.
  }
  throw new Error('Electron is unavailable. Install the optional electron dependency to open Holonomy DevTools.')
}

export const openHolonomyDevTools = (devtoolsUrl, options = {}) => {
  const parsed = new URL(devtoolsUrl)
  if (parsed.protocol !== 'devtools:') throw new Error('Holonomy DevTools URL is invalid')
  const executable = options.executable ?? resolveHolonomyElectronExecutable()
  if (!existsSync(executable)) throw new Error('Holonomy DevTools executable is unavailable')
  const child = (options.spawn ?? spawn)(executable, [
    resolve(root, 'tools/android-devtools-electron.mjs'),
    `--devtools-url=${devtoolsUrl}`
  ], {
    cwd: root,
    detached: true,
    stdio: 'ignore'
  })
  child.unref()
}
