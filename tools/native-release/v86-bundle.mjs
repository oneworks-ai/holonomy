import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describeFile } from './manifest.mjs'
import { prepareNativeV86CatExample } from './v86-smoke.mjs'

export const prepareNativeV86Bundle = async ({ bundle, v86 }) => {
  await mkdir(join(bundle, 'private/v86-assets'), { recursive: true })
  for (const [name, input] of Object.entries(v86.files)) {
    const path = join(bundle, 'private/v86-assets', name)
    await writeFile(path, input.buffer)
    if ((await describeFile(path)).sha256 !== input.description.sha256) {
      throw new Error(`v86 asset changed while packaging: ${name}`)
    }
  }
  await writeFile(
    join(bundle, 'index.js'),
    "if (process.versions.node !== undefined) throw new Error('Node is installed in the Guest');\nconsole.log('HOLO_NATIVE_ARTIFACT_OK');\n"
  )
  await prepareNativeV86CatExample({ bundle, assets: v86.manifest.assets })
  await writeFile(
    join(bundle, 'V86-EXPERIMENTAL.md'),
    '# Experimental v86 development artifact\n\n' +
      'Run `./bin/holo ./index.js` without Node. The v86 Process Backend is compiled but remains disabled by default.\n' +
      'For the bounded cat example, run `./configure-v86.sh` once from this extracted directory, then:\n\n' +
      "```sh\nPATH='' ./bin/holo --timeout 60000 --host-config ./private/host-cat.json " +
      '--process-profiles ./private/process-profiles.json --process-backends ./private/process-backends.json ' +
      '--experimental-v86-process ./cat-example.mjs\n```\n\n' +
      'The setup script creates an owner-only Backend manifest with the final absolute asset root; ' +
      'it refuses to replace an existing manifest. The owner-only Process profile pins all four SHA-256 values.\n\n' +
      'This image permits the first root exec only; Guest descendant fork/exec is denied. ' +
      'The image SPDX inventory, native sbom.spdx.json, and THIRD-PARTY-NOTICES.json ' +
      'are machine-checkable development evidence, not a complete redistribution closure. ' +
      'This archive is unsigned, unnotarized, and development-only.\n'
  )
  return [
    'index.js',
    'V86-EXPERIMENTAL.md',
    'configure-v86.sh',
    'cat-example.mjs',
    'private/host-cat.json',
    'private/process-profiles.json',
    ...Object.keys(v86.files).map(name => `private/v86-assets/${name}`)
  ]
}
