import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
// eslint-disable-next-line test/no-import-node-test -- Adapter tests use Node's public runner.
import test from 'node:test'

import {
  V86_KERNEL_CONFIG_DISABLED_REQUIREMENTS_V1,
  V86_KERNEL_CONFIG_REQUIREMENTS_V1,
  parseLinuxKernelConfigV1,
  verifyV86KernelConfigV1
} from '../../../backends/v86/kernel/kernel-config.mjs'

const fragmentUrl = new URL('../../../backends/v86/kernel/holonomy-v86.fragment', import.meta.url)

test('freezes built-in v86 boot, filesystem and network Bridge kernel requirements', async () => {
  const source = await readFile(fragmentUrl, 'utf8')
  const manifest = JSON.parse(
    await readFile(new URL('../../../backends/v86/kernel/linux-source.json', import.meta.url), 'utf8')
  )
  const result = verifyV86KernelConfigV1(source)
  assert.deepEqual(manifest, {
    repository: 'https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git',
    revision: '632428373bea7581869cb05dce40bef0d37793e3',
    schemaVersion: 1,
    tag: 'v6.8.12'
  })
  assert.deepEqual(result.groups.map(item => item.group), ['boot', 'filesystemBridge', 'networkBridge'])
  assert.deepEqual(result.disabledSymbols, ['CONFIG_MTRR', 'CONFIG_X86_PAT'])
  assert.equal(
    result.requiredSymbolCount,
    Object.values(V86_KERNEL_CONFIG_REQUIREMENTS_V1).flat().length +
      V86_KERNEL_CONFIG_DISABLED_REQUIREMENTS_V1.length
  )
})

test('rejects disabled, modular and duplicate v86 Bridge kernel requirements', async () => {
  const source = await readFile(fragmentUrl, 'utf8')
  assert.throws(() => verifyV86KernelConfigV1(source.replace('CONFIG_FUSE_FS=y', 'CONFIG_FUSE_FS=m')), {
    message: /CONFIG_FUSE_FS/u
  })
  assert.throws(() => verifyV86KernelConfigV1(source.replace('CONFIG_TUN=y', '# CONFIG_TUN is not set')), {
    message: /CONFIG_TUN/u
  })
  assert.throws(() => parseLinuxKernelConfigV1(`${source}\nCONFIG_FUSE_FS=y\n`), {
    message: /Duplicate Linux kernel configuration/u
  })
  assert.throws(() => verifyV86KernelConfigV1(source.replace('# CONFIG_X86_PAT is not set', 'CONFIG_X86_PAT=y')), {
    message: /CONFIG_X86_PAT/u
  })
  assert.equal(parseLinuxKernelConfigV1('# CONFIG_SCx200 is not set').get('CONFIG_SCx200'), 'n')
})
