import {
  createSystemProjectionFixture,
  systemInformationPolicy
} from '../../../conformance/capabilities/system-projection-fixture.mjs'

export { systemInformationPolicy }
export const systemProjection = createSystemProjectionFixture({ platform: 'darwin', type: 'Darwin' })
