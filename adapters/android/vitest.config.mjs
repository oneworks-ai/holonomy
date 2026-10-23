import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { conditions: ['__oneworks__'] },
  test: {
    environment: 'node',
    include: ['adapters/android/e2e/tools/__tests__/*.test.mjs']
  }
})
