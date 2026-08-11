import { idParameter, response, secured } from './openapi-helpers.mjs'

export const OPENAPI_SKILL_PATHS = {
  '/.oo/skills/index.json': {
    get: secured({
      operationId: 'getSkillIndex',
      responses: { 200: response('Holonomy scenario skill index') },
      tags: ['Skills']
    })
  },
  '/.oo/skills/{scenario}/SKILL.md': {
    get: secured({
      operationId: 'getScenarioSkill',
      parameters: [idParameter('scenario', 'Scenario skill name')],
      responses: { 200: response('Holonomy scenario skill markdown') },
      tags: ['Skills']
    })
  },
  '/.oo/skills/{scenario}/references/{reference}': {
    get: secured({
      operationId: 'getScenarioSkillReference',
      parameters: [
        idParameter('scenario', 'Scenario skill name'),
        idParameter('reference', 'Scenario reference markdown name')
      ],
      responses: { 200: response('Holonomy scenario skill reference markdown') },
      tags: ['Skills']
    })
  }
}
