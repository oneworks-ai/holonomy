export const persistAndroidAdbLease = async (store, lease, rollback) => {
  try {
    await store.add(lease)
  } catch (error) {
    await rollback().catch(() => undefined)
    throw error
  }
}

export const removeVerifiedAndroidAdbLease = async (remove, verifyAbsent, removePersisted) => {
  try {
    await remove()
  } catch (error) {
    if (await verifyAbsent() !== true) throw error
  }
  await removePersisted()
}

export const androidAdbEndpointAbsent = (output, serial, endpoint) =>
  !output.split('\n').some(line => {
    const fields = line.trim().split(/\s+/u)
    return fields.includes(serial) && fields.includes(endpoint)
  })

const removeAndroidAdbMapping = async (options, direction, kind, portField) => {
  const endpoint = `tcp:${options.port}`
  await removeVerifiedAndroidAdbLease(
    () =>
      options.execute(options.adb, ['-s', options.serial, direction, '--remove', endpoint], {
        timeoutMs: options.timeoutMs
      }),
    async () =>
      androidAdbEndpointAbsent(
        await options.execute(options.adb, ['-s', options.serial, direction, '--list'], {
          timeoutMs: options.timeoutMs
        }),
        options.serial,
        endpoint
      ),
    () =>
      options.store.remove(lease => (
        lease.kind === kind && lease.serial === options.serial && lease[portField] === options.port
      ))
  )
}

export const removeAndroidAdbForward = async options =>
  await removeAndroidAdbMapping(
    options,
    'forward',
    'inspector-forward',
    'localPort'
  )

export const removeAndroidAdbReverse = async options =>
  await removeAndroidAdbMapping(
    options,
    'reverse',
    'fixture-reverse',
    'remotePort'
  )

export const cleanupAndroidProcessLeases = async (
  store,
  processId,
  generation,
  removeForward,
  removeReverse
) => {
  await store.open()
  const leases = store.list(lease => lease.processId === processId && lease.generation === generation)
  for (const lease of leases) {
    if (lease.kind === 'inspector-forward') await removeForward(lease.serial, lease.localPort)
    if (lease.kind === 'fixture-reverse') await removeReverse(lease.serial, lease.remotePort)
  }
  return leases.length
}
