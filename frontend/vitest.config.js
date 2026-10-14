import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Test-only config — dev/build still use vite.config.js.
// jsdom so component tests can exercise DOM/history APIs.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.js'],
    // Forks pool hangs on this machine (Windows + Node 24); threads is stable.
    pool: 'threads',
  },
})
