import { invocationJsonDigestV1 } from '@holonomyjs/runtime/kernel/json-invocation-value'
import type { JsonValueV1 } from '@holonomyjs/runtime/kernel/json-types'
import { canonicalizeProgramExecutableResource } from './canonical-process-resources.js'

export const routeDescendantProcessInvocationV1 = (
  input: Readonly<Record<string, JsonValueV1>>
) => ({
  preferredProviderModule: 'host.process',
  resource: canonicalizeProgramExecutableResource({
    argvDigest: invocationJsonDigestV1(input.argv ?? []),
    cwdSemanticResourceDigest: invocationJsonDigestV1([
      'linuxCwd',
      input.environmentId ?? null,
      input.cwd ?? null
    ]),
    environmentNamesDigest: invocationJsonDigestV1([]),
    environmentScope: input.environmentScope,
    executableId: input.executableId,
    label: String(input.path ?? '').slice(0, 256),
    stdioDigest: invocationJsonDigestV1(['inherited', 'inherited', 'inherited'])
  })
})
