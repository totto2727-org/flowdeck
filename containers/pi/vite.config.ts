import { copyFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite-plus'

export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  plugins: [
    {
      name: 'container-runtime-manifest',
      closeBundle() {
        copyFileSync(new URL('../../package.json', import.meta.url), new URL('./dist/package.json', import.meta.url))
        copyFileSync(
          new URL('../../pnpm-lock.yaml', import.meta.url),
          new URL('./dist/pnpm-lock.yaml', import.meta.url),
        )
        copyFileSync(
          new URL('../../pnpm-workspace.yaml', import.meta.url),
          new URL('./dist/pnpm-workspace.yaml', import.meta.url),
        )
      },
    },
  ],
  build: {
    target: 'node24',
    ssr: fileURLToPath(new URL('./server.ts', import.meta.url)),
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {
      external: [...builtinModules, /^node:/, /^@earendil-works\/pi-(coding-agent|ai)(\/|$)/],
      output: { entryFileNames: 'server.mjs', codeSplitting: false },
    },
  },
  ssr: { noExternal: true, external: ['@earendil-works/pi-coding-agent', '@earendil-works/pi-ai'] },
  test: {
    environment: 'node',
    include: ['containers/pi/*.test.ts'],
    testTimeout: 10_000,
  },
})
