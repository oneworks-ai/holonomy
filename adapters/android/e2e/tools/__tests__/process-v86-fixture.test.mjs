import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { parse } from 'acorn'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { v86TestBudget } from '../../../../../conformance/capabilities/process-v86-watchdog.mjs'

let assetRoot
afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
  if (assetRoot) rmSync(assetRoot, { recursive: true, force: true })
  assetRoot = undefined
})

describe('v86 fixture budget and source closure', () => {
  it('packages the relative helper and binds metadata to the admitted execution Policy', async () => {
    const scratch = join(process.cwd(), 'work', 'v86-test-budget')
    mkdirSync(scratch, { recursive: true })
    assetRoot = mkdtempSync(join(scratch, 'descriptor-assets-'))
    // Descriptor admission only. These inert bytes never boot a VM.
    for (const file of ['seabios.bin', 'agent.cpio', 'kernel.bin', 'v86.wasm']) {
      writeFileSync(join(assetRoot, file), 'descriptor-only-test-asset')
    }
    vi.stubEnv('HOLO_V86_PROBE_ASSET_ROOT', assetRoot)
    const { generateCapabilityKernelFixture } = await import('../generate-capability-kernel-fixture.mjs')
    const fixture = JSON.parse((await generateCapabilityKernelFixture()).bytes.toString())
    expect(fixture.v86TestBudget).toEqual(v86TestBudget)
    const policy = fixture.capabilityRuntime.runtimeCreation.configuration.sandboxPolicy.process
    expect(policy.limits.maxExecutionTimeMs).toBe(v86TestBudget.maxExecutionTimeMs)
    const modules = new Map(fixture.modules.map(module => [module.url, module.source]))
    const entry = 'fixture+session://runtime/conformance/process-v86.test.mjs'
    const helper = new URL('./process-v86-watchdog.mjs', entry).href
    expect(modules.get(helper)).toBe(readFileSync(
      new URL(
        '../../../../../conformance/capabilities/process-v86-watchdog.mjs',
        import.meta.url
      ),
      'utf8'
    ))
    for (const url of [entry, helper]) {
      const ast = parse(modules.get(url), { ecmaVersion: 'latest', sourceType: 'module' })
      for (const node of ast.body) {
        if (node.type !== 'ImportDeclaration' || !node.source.value.startsWith('.')) continue
        expect(modules.has(new URL(node.source.value, url).href)).toBe(true)
      }
    }
    // The same unchanged source has a real file URL on the Node side.
    const nodeEntry = pathToFileURL(join(process.cwd(), 'conformance/capabilities/process-v86.test.mjs'))
    expect(await import(new URL('./process-v86-watchdog.mjs', nodeEntry).href)).toHaveProperty('watchV86Child')
  })

  it('omits v86 metadata and modules when the optional backend is disabled', async () => {
    vi.stubEnv('HOLO_V86_PROBE_ASSET_ROOT', '')
    const { generateCapabilityKernelFixture } = await import('../generate-capability-kernel-fixture.mjs')
    const fixture = JSON.parse((await generateCapabilityKernelFixture()).bytes.toString())
    expect(fixture.v86TestBudget).toBeUndefined()
    expect(fixture.modules.some(module => module.url.includes('process-v86'))).toBe(false)
  })
})
