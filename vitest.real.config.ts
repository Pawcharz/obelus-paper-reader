import { defineConfig } from 'vitest/config'

// Checks against real papers and live services. Not part of the normal test run.
export default defineConfig({
  test: { include: ['tests/real/**/*.test.ts'], environment: 'node', testTimeout: 300000 }
})
