import { SERVICE_API_VERSION } from './constants.mjs'
import { OPENAPI_COMPONENTS } from './openapi-components.mjs'
import { OPENAPI_PATHS } from './openapi-paths.mjs'
import { OPENAPI_PROCESS_PATHS } from './openapi-process-paths.mjs'
import { OPENAPI_SKILL_PATHS } from './openapi-skill-paths.mjs'

export const HOLONOMY_SERVICE_OPENAPI = Object.freeze({
  components: OPENAPI_COMPONENTS,
  info: {
    description: 'Machine-local device and Holonomy runtime process lifecycle service.',
    title: 'Holonomy Service',
    version: SERVICE_API_VERSION
  },
  jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
  openapi: '3.1.0',
  paths: { ...OPENAPI_PATHS, ...OPENAPI_PROCESS_PATHS, ...OPENAPI_SKILL_PATHS },
  'x-holonomy-skills': {
    index: '/.oo/skills/index.json',
    referenceTemplate: '/.oo/skills/{scenario}/references/{reference}',
    resourceTemplate: '/.oo/skills/{scenario}/SKILL.md'
  },
  tags: [
    { name: 'Control' },
    { name: 'Devices' },
    { name: 'Events' },
    { name: 'Emulators' },
    { name: 'Inspectors' },
    { name: 'Network rules' },
    { name: 'Operations' },
    { name: 'Processes' },
    { name: 'Skills' }
  ]
})
