import { BrowserWindow, app } from 'electron'

const reconnectIntervalMs = 1_000
let discoveryUrl = app.commandLine.getSwitchValue('discovery-url') || 'http://127.0.0.1:9229/json/list'
let devtoolsUrl = app.commandLine.getSwitchValue('devtools-url') || undefined
let window
let attachedTargetSignature
let waiting = false

function waitingPage() {
  const escaped = discoveryUrl.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  return `data:text/html;charset=utf-8,${
    encodeURIComponent(`<!doctype html>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
    <title>Holonomy DevTools</title>
    <style>
      :root { color-scheme: dark; font: 14px system-ui; background: #202124; color: #e8eaed; }
      body { display: grid; min-height: 100vh; margin: 0; place-items: center; }
      main { max-width: 560px; padding: 32px; text-align: center; }
      code { color: #8ab4f8; }
    </style>
    <main><h1>Holonomy DevTools</h1><p>Waiting for the managed V8 runtime…</p><code>${escaped}</code></main>`)
  }`
}

async function discoverTarget() {
  if (devtoolsUrl != null) {
    return { devtoolsFrontendUrl: devtoolsUrl, webSocketDebuggerUrl: devtoolsUrl }
  }
  const response = await fetch(discoveryUrl, { signal: AbortSignal.timeout(750) })
  if (!response.ok) throw new Error('Discovery endpoint is unavailable')
  const targets = await response.json()
  if (!Array.isArray(targets) || targets.length === 0) throw new Error('No inspector target is available')
  return targets[0]
}

async function refresh() {
  if (!window || window.isDestroyed()) return
  try {
    const target = await discoverTarget()
    waiting = false
    const signature = `${target.webSocketDebuggerUrl}#${target.holonomySession ?? 'unknown'}`
    if (attachedTargetSignature === signature) return
    attachedTargetSignature = signature
    await window.loadURL(target.devtoolsFrontendUrl)
  } catch {
    attachedTargetSignature = undefined
    if (waiting) return
    waiting = true
    await window.loadURL(waitingPage())
  }
}

function createWindow() {
  window = new BrowserWindow({
    backgroundColor: '#202124',
    height: 900,
    minHeight: 600,
    minWidth: 800,
    show: false,
    title: 'Holonomy DevTools',
    width: 1440,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })
  window.once('ready-to-show', () => window.show())
  window.webContents.on('did-fail-load', () => {
    attachedTargetSignature = undefined
  })
  window.on('closed', () => {
    window = undefined
  })
  void refresh()
}

const singleInstance = app.requestSingleInstanceLock({ devtoolsUrl, discoveryUrl })
if (!singleInstance) app.quit()
else {
  app.on('second-instance', (_event, argv, _workingDirectory, additionalData) => {
    devtoolsUrl = additionalData.devtoolsUrl ??
      argv.find(argument => argument.startsWith('--devtools-url='))?.slice('--devtools-url='.length)
    discoveryUrl = additionalData.discoveryUrl ??
      argv.find(argument => argument.startsWith('--discovery-url='))?.slice('--discovery-url='.length) ??
      discoveryUrl
    attachedTargetSignature = undefined
    waiting = false
    if (!window) createWindow()
    window?.show()
    window?.focus()
    void refresh()
  })
  app.whenReady().then(() => {
    createWindow()
    setInterval(() => void refresh(), reconnectIntervalMs).unref()
  })
  app.on('activate', () => {
    if (!window) createWindow()
  })
  app.on('window-all-closed', () => app.quit())
}
