import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'

import { HOLONOMY_SERVICE_OPENAPI } from '../openapi.mjs'
import { ServiceSkillResources } from '../skill-resources.mjs'

describe('service skill resources', () => {
  it('serves only bounded allowlisted index and scenario skill files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'holonomy-service-skills-'))
    const scenario = join(directory, 'run-runtime')
    const linkedFileScenario = join(directory, 'linked-file')
    await mkdir(join(scenario, 'references'), { recursive: true })
    await mkdir(linkedFileScenario, { recursive: true })
    await writeFile(join(directory, 'index.json'), '{"skills":["run-runtime"]}\n')
    await writeFile(join(scenario, 'SKILL.md'), '# Run Runtime\n')
    await writeFile(join(scenario, 'references', 'contract.md'), '# Contract\n')
    await symlink(join(scenario, 'SKILL.md'), join(linkedFileScenario, 'SKILL.md'))
    await symlink(scenario, join(directory, 'linked'))
    try {
      const resources = new ServiceSkillResources({ directory })
      const index = await resources.read('/.oo/skills/index.json')
      assert.equal(index.contentType, 'application/json; charset=utf-8')
      assert.equal(index.body.toString('utf8'), '{"skills":["run-runtime"]}\n')
      const skill = await resources.read('/.oo/skills/run-runtime/SKILL.md')
      assert.equal(skill.contentType, 'text/markdown; charset=utf-8')
      const reference = await resources.read('/.oo/skills/run-runtime/references/contract.md')
      assert.equal(reference.body.toString('utf8'), '# Contract\n')
      await assert.rejects(
        resources.read('/.oo/skills/linked/SKILL.md'),
        error => error.code === 'service.not_found'
      )
      await assert.rejects(
        resources.read('/.oo/skills/linked-file/SKILL.md'),
        error => error.code === 'service.not_found'
      )
      await assert.rejects(
        new ServiceSkillResources({ directory, maxBytes: 8 }).read('/.oo/skills/run-runtime/SKILL.md'),
        error => error.code === 'service.limit_exceeded'
      )
      assert.deepEqual(HOLONOMY_SERVICE_OPENAPI['x-holonomy-skills'], {
        index: '/.oo/skills/index.json',
        referenceTemplate: '/.oo/skills/{scenario}/references/{reference}',
        resourceTemplate: '/.oo/skills/{scenario}/SKILL.md'
      })
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })
})
