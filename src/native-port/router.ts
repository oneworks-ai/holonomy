import type {
  NativeCallToken,
  NativeDispatchContext,
  NativePort,
  NativePortEvent,
  NativePortEventSink,
  NativePortRequest,
  NativePortResourceEventSink,
  NativeProviderToken
} from './types.js'

export interface RuntimeNativeHostRoute {
  readonly modules: readonly string[]
  readonly port: NativePort
  /** Any one of these host-injected capabilities admits the route. */
  readonly requiredCapabilities?: readonly string[]
}

const resourceKey = (owner: NativeCallToken, provider: NativeProviderToken) => `${owner}\0${provider}`

/** Routes modules while keeping Bridge calls and opaque resources with one owner. */
export class RuntimeNativeHostRouter implements NativePort {
  private readonly calls = new Map<NativeCallToken, NativePort>()
  private readonly modules = new Map<string, Readonly<{ port: NativePort; requiredCapabilities: readonly string[] }>>()
  private readonly ports: readonly NativePort[]
  private readonly resources = new Map<string, NativePort>()
  private disposed = false

  constructor(routes: readonly RuntimeNativeHostRoute[]) {
    if (!Array.isArray(routes) || routes.length === 0) throw new TypeError('At least one NativePort route is required')
    const ports: NativePort[] = []
    for (const route of routes) {
      if (route == null || typeof route !== 'object' || !Array.isArray(route.modules)) {
        throw new TypeError('Invalid NativePort route')
      }
      const required = route.requiredCapabilities ?? []
      if (!Array.isArray(required) || required.some(value => typeof value !== 'string' || value.length === 0)) {
        throw new TypeError('Invalid NativePort route capabilities')
      }
      if (!ports.includes(route.port)) ports.push(route.port)
      for (const module of route.modules) {
        if (typeof module !== 'string' || module.length === 0 || this.modules.has(module)) {
          throw new TypeError(`Duplicate or invalid NativePort module owner: ${String(module)}`)
        }
        this.modules.set(
          module,
          Object.freeze({
            port: route.port,
            requiredCapabilities: Object.freeze([...new Set(required)])
          })
        )
      }
    }
    this.ports = Object.freeze(ports)
  }

  cancel(callToken: NativeCallToken, reason?: string) {
    const port = this.calls.get(callToken)
    this.calls.delete(callToken)
    return port?.cancel(callToken, reason)
  }

  closeResource(ownerCallToken: NativeCallToken, providerToken: NativeProviderToken, reason?: string) {
    const key = resourceKey(ownerCallToken, providerToken)
    const port = this.resources.get(key)
    this.resources.delete(key)
    return port?.closeResource(ownerCallToken, providerToken, reason)
  }

  dispatch(
    request: NativePortRequest,
    context: Readonly<NativeDispatchContext>,
    sink: NativePortEventSink,
    resourceSink: NativePortResourceEventSink
  ) {
    if (this.disposed) {
      sink({ error: { code: 'disposed' }, id: request.id, type: 'error' })
      return
    }
    const route = this.modules.get(request.module)
    if (
      route == null ||
      (route.requiredCapabilities.length > 0 &&
        !route.requiredCapabilities.some(capability => context.authority.capabilities.includes(capability)))
    ) {
      sink({ error: { code: 'capability_unsupported' }, id: request.id, type: 'error' })
      return
    }
    const port = route.port
    this.calls.set(context.callToken, port)
    let terminal = false
    const emit = (event: NativePortEvent) => {
      if (terminal) return
      if ('resources' in event) {
        for (const grant of event.resources ?? []) {
          this.resources.set(resourceKey(context.callToken, grant.providerToken), port)
        }
      }
      if (event.type === 'error' || event.type === 'result' || event.type === 'end') {
        terminal = true
        this.calls.delete(context.callToken)
      }
      sink(event)
    }
    const emitResource: NativePortResourceEventSink = event => {
      this.resources.delete(resourceKey(context.callToken, event.providerToken))
      resourceSink(event)
    }
    try {
      const pending = port.dispatch(request, context, emit, emitResource)
      if (pending != null) {
        return Promise.resolve(pending).catch(() => {
          if (terminal) return
          this.calls.delete(context.callToken)
          emit({ error: { code: 'internal' }, id: request.id, type: 'error' })
        })
      }
    } catch {
      this.calls.delete(context.callToken)
      emit({ error: { code: 'internal' }, id: request.id, type: 'error' })
    }
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    this.calls.clear()
    this.resources.clear()
    await Promise.all(this.ports.map(async port => {
      try {
        await port.dispose()
      } catch {
        // Every child is attempted; platform errors remain behind the port.
      }
    }))
  }

  grantCredits(callToken: NativeCallToken, credits: number) {
    return this.calls.get(callToken)?.grantCredits(callToken, credits)
  }
}

export const createRuntimeNativeHostRouter = (routes: readonly RuntimeNativeHostRoute[]) => (
  new RuntimeNativeHostRouter(routes)
)
