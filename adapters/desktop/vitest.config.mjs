import { defineConfig } from 'vitest/config'

import shared from '../../vitest.config.ts'

export default defineConfig({
  ...shared,
  test: {
    ...shared.test,
    include: ['adapters/desktop/v8-host/tests/**/*.test.{ts,mjs}']
  }
})
