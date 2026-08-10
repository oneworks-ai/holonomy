import { defineConfig } from 'vitest/config'

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
    include: ['__tests__/**/*.spec.ts']
  }
})
