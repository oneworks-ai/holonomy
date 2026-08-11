import { defineConfig } from 'vitest/config'

export const testLayerIncludes = Object.freeze({
  cli: '__tests__/cli/**/*.spec.ts',
  js: '__tests__/js-api/**/*.spec.ts',
  runtime: '__tests__/js-runtime-kernel/**/*.spec.ts'
})

export default defineConfig({
  resolve: {
    conditions: ['__oneworks__']
  },
  test: {
    environment: 'node',
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**'
    ],
    include: Object.values(testLayerIncludes)
  }
})
