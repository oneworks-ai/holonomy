import path from 'node:path'

// eslint-disable-next-line no-debugger -- This example is a stable Inspector breakpoint target.
debugger
console.log('Holonomy inspector ready', path.basename('/workspace/debuggable.mjs'))
await new Promise(resolve => setTimeout(resolve, 10_000))
console.log('Holonomy inspector session complete')
