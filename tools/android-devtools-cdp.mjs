const defaultTimeoutMs = 15_000

function delay(milliseconds) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds))
}

export async function readTarget(port, timeoutMs = defaultTimeoutMs) {
  const discoveryUrl = `http://127.0.0.1:${port}/json/list`
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(discoveryUrl, { signal: AbortSignal.timeout(1_000) })
      if (response.ok) {
        const targets = await response.json()
        if (Array.isArray(targets) && targets.length > 0) return targets[0]
      }
    } catch {}
    await delay(150)
  }
  throw new Error(`Timed out waiting for the Holonomy DevTools target at ${discoveryUrl}`)
}

export async function resumeTarget(target, timeoutMs = 5_000) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const socket = new WebSocket(target.webSocketDebuggerUrl)
    const timer = setTimeout(() => finish(new Error('Timed out resuming the Holonomy V8 target')), timeoutMs)
    let settled = false

    function finish(error) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.close()
      if (error) rejectPromise(error)
      else resolvePromise()
    }

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ id: 1, method: 'Runtime.runIfWaitingForDebugger' }))
    })
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data))
      if (message.id === 1) finish(message.error == null ? undefined : new Error('The V8 target rejected resume'))
    })
    socket.addEventListener('error', () => finish(new Error('Could not resume the Holonomy CDP target')))
    socket.addEventListener('close', () => finish(new Error('The Holonomy CDP target closed before resume')))
  })
}

export async function probeTarget(target, expression = '6 * 7', timeoutMs = 5_000) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const socket = new WebSocket(target.webSocketDebuggerUrl)
    const timer = setTimeout(
      () => finish(new Error('Timed out waiting for a CDP Runtime.evaluate response')),
      timeoutMs
    )
    let settled = false

    function finish(error, value) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.close()
      if (error) rejectPromise(error)
      else resolvePromise(value)
    }

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }))
      socket.send(JSON.stringify({ id: 3, method: 'Runtime.runIfWaitingForDebugger' }))
      socket.send(JSON.stringify({
        id: 2,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true }
      }))
    })
    socket.addEventListener('message', event => {
      try {
        const message = JSON.parse(String(event.data))
        if (message.id !== 2) return
        if (message.error) finish(new Error('The runtime rejected the CDP probe'))
        else if (message.result?.exceptionDetails) finish(new Error('The CDP probe expression threw'))
        else finish(undefined, message.result?.result?.value)
      } catch {
        finish(new Error('The runtime returned a malformed CDP response'))
      }
    })
    socket.addEventListener('error', () => finish(new Error('Could not connect to the Holonomy CDP WebSocket')))
    socket.addEventListener(
      'close',
      () => finish(new Error('The Holonomy CDP WebSocket closed before the probe completed'))
    )
  })
}
