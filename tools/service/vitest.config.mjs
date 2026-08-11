import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    fileParallelism: false,
    include: ['tools/service/__tests__/*.test.mjs']
  }
})
