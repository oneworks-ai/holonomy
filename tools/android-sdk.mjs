import process from 'node:process'

import { packageAndroidSdk, verifyAndroidSdk } from './android-sdk/package.mjs'

const help = 'Usage: node tools/android-sdk.mjs --output <new-directory> [--skip-build]\n' +
  '       node tools/android-sdk.mjs verify <directory>\n' +
  'Builds development AARs by default. Verification proves bytes/inventory, not device acceptance or publication.\n'

const main = async args => {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    process.stdout.write(help)
    return
  }
  if (args[0] === 'verify' && args.length === 2) {
    process.stdout.write(`${JSON.stringify(await verifyAndroidSdk(args[1]), null, 2)}\n`)
    return
  }
  let output
  let skipBuild = false
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--output' && output == null && args[index + 1] && !args[index + 1].startsWith('--')) {
      output = args[++index]
    } else if (args[index] === '--skip-build' && !skipBuild) skipBuild = true
    else throw new Error(help)
  }
  if (output == null) throw new Error(help)
  process.stdout.write(`${JSON.stringify(await packageAndroidSdk({ output, skipBuild }), null, 2)}\n`)
}

main(process.argv.slice(2)).catch(error => {
  process.stderr.write(`${String(error?.message ?? 'Android SDK packaging failed')}\n`)
  process.exitCode = 1
})
