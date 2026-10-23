import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: [{
      find: /^\.\/modules\/web-network\/web-abort\.js$/u,
      replacement: new URL('../../../src/web-network/web-abort.ts', import.meta.url).pathname
    }]
  },
  test: {
    environment: 'node',
    include: ['adapters/android/runtime-host/tools/__tests__/*.test.mjs']
  }
})
