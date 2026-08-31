export const testRunnerSource = (entryUrls, reporter) => `
import process from 'node:process'
import { run } from 'node:test'
${entryUrls.map(url => `import ${JSON.stringify(url)}`).join('\n')}

const renderHolonomyTap = summary => {
  const lines = ['TAP version 13']
  summary.results.forEach((result, index) => {
    const name = [...result.path, result.name].join(' > ')
    if (result.status === 'passed') lines.push('ok ' + (index + 1) + ' - ' + name)
    else if (result.status === 'skipped') lines.push('ok ' + (index + 1) + ' - ' + name + ' # SKIP platform')
    else lines.push('not ok ' + (index + 1) + ' - ' + name + '\\n  ---\\n  message: ' + JSON.stringify(result.failure?.message) + '\\n  ...')
  })
  lines.push('1..' + summary.results.length)
  lines.push('# tests ' + summary.total)
  lines.push('# pass ' + summary.passed)
  lines.push('# fail ' + summary.failed)
  lines.push('# common ' + summary.common.passed + '/' + summary.common.total)
  return lines.join('\\n') + '\\n'
}

run().then(summary => {
  process.stdout.write(${
  JSON.stringify(reporter)
} === 'json' ? JSON.stringify(summary) + '\\n' : renderHolonomyTap(summary))
  process.stdout.write('# holonomy-result ' + JSON.stringify(summary) + '\\n')
  try {
    process.exit(summary.failed === 0 ? 0 : 1)
  } catch {}
}, error => {
  process.stderr.write('Holonomy test runner failed: ' + (error?.message ?? 'unknown error') + '\\n')
  try {
    process.exit(1)
  } catch {}
})
`

export const runWrapperSource = (entryUrl, watch = false) => `
import process from 'node:process'
import ${JSON.stringify(entryUrl)}

${
  watch
    ? `// Keep the Runtime event loop active after entry evaluation so the Host
// can replace Cordis plugin scopes without blocking launch admission.
setInterval(() => {}, 2_147_483_647)`
    : `try {
  process.exit(process.exitCode)
} catch {}`
}
`
