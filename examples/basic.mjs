import path from 'node:path'

console.log('Holonomy started', path.basename('/workspace/example.mjs'))
await new Promise(resolve => setTimeout(resolve, 25))
console.log('Holonomy timer fired', 6 * 7)
