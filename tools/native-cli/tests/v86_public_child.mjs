// Bounded lifecycle for the external CLI fixture, not a Runtime implementation.
export const observeNativeFixtureChildClose = child => {
  let didClose = false
  let error
  child.on('error', failure => error ??= failure)
  const closed = new Promise(resolve =>
    child.once('close', (code, signal) => {
      didClose = true
      resolve([code, signal])
    })
  )
  return Object.freeze({
    closed,
    get didClose() {
      return didClose
    },
    get error() {
      return error
    }
  })
}

export const waitNativeFixture = async (promise, timeoutMs) => {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Native fixture did not settle before its deadline')), timeoutMs)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

export const stopNativeFixtureChildren = async entries => {
  for (const [child] of entries) child.kill('SIGTERM')
  const closed = Promise.all(entries.map(([, promise]) => promise))
  try {
    // The CLI owns a one-second grace before killing its Runtime group. Do not
    // race that grace by killing only the CLI first.
    await waitNativeFixture(closed, 2500)
  } catch {
    for (const [child] of entries) child.kill('SIGKILL')
    try {
      await waitNativeFixture(closed, 1000)
    } catch (error) {
      for (const [child] of entries) {
        child.stdout.destroy()
        child.stderr.destroy()
      }
      // A signal send does not prove cleanup of the separate Runtime group.
      throw error
    }
  }
}
