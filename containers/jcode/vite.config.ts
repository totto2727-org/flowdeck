import { builtinModules } from 'node:module'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite-plus'

export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  build: {
    target: 'node24',
    ssr: fileURLToPath(new URL('./server.ts', import.meta.url)),
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {
      external: [...builtinModules, /^node:/],
      output: { entryFileNames: 'server.mjs', codeSplitting: false },
    },
  },
  ssr: { noExternal: true },
  test: {
    environment: 'node',
    include: ['containers/jcode/*.test.ts'],
    testTimeout: 10_000,
  },
})
