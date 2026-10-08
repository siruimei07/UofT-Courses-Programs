import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: process.env.BASE_PATH || '/',
  build: { chunkSizeWarningLimit: 650 },
  // Real-data sweeps take seconds locally and longer on shared CI runners.
  test: { include: ['tests/**/*.test.ts'], environment: 'node', testTimeout: 120_000, hookTimeout: 120_000 },
})
