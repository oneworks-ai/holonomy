import {
  MemoryFsNativePort,
  RuntimeEventLoop,
  createFsAuthority,
  createNativeBridge,
  createNodeFsFacade,
  nativeAuthorityForFs
} from '../../src/index.js'

import type { FsPermission, HostEventLoopPort, MemoryFsLimits, NativeBridgeLimits } from '../../src/index.js'

class VirtualFsHost implements HostEventLoopPort {
  #now = 0

  now() {
    return this.#now
  }

  advanceTo(value: number) {
    this.#now = value
  }
  requestWakeup(_deadlineMs: number | null) {}
  checkpointMicrotasks() {}
  terminate(_reason: Parameters<HostEventLoopPort['terminate']>[0]) {}
}

interface MemoryFsFixtureOptions {
  bridgeLimits?: Partial<NativeBridgeLimits>
  limits?: Partial<MemoryFsLimits>
  permissions?: readonly FsPermission[]
}

export const setupMemoryFs = (options: MemoryFsFixtureOptions = {}) => {
  const permissions = options.permissions ?? ['metadata', 'read', 'write']
  const authority = createFsAuthority({
    capabilities: ['host.fs.v1'],
    principal: 'plugin-1',
    roots: {
      'app-data': { permissions, rootId: 'app-data-1' },
      workspace: { permissions, rootId: 'workspace-1' }
    }
  })
  const host = new VirtualFsHost()
  const loop = new RuntimeEventLoop(host)
  const port = new MemoryFsNativePort({ authorities: [authority], limits: options.limits })
  const bridge = createNativeBridge(port, {
    authority: nativeAuthorityForFs(authority),
    eventLoop: loop,
    limits: options.bridgeLimits
  })
  return {
    authority,
    bridge,
    fs: createNodeFsFacade(bridge, {
      chunkBytes: 4,
      now: loop.getCurrentTime.bind(loop)
    }),
    host,
    loop,
    port
  }
}

export const settle = async <T>(loop: RuntimeEventLoop, promise: Promise<T>) => {
  let settled = false
  let failure: unknown
  let value!: T
  void promise.then(result => {
    settled = true
    value = result
  }, error => {
    settled = true
    failure = error
  })
  for (let index = 0; index < 128; index += 1) {
    if (settled) break
    if (loop.getSnapshot().hasPendingWork) loop.runTurn()
    await Promise.resolve()
  }
  if (!settled) throw new Error('mobile fs promise did not settle')
  if (failure !== undefined) throw failure
  return value
}
