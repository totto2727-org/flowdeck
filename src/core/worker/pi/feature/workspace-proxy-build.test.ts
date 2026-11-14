import { fileURLToPath } from 'node:url'

import { Array } from 'effect'
import { build } from 'vite-plus'
import { describe, expect, it } from 'vite-plus/test'

import { workspaceProxyBuild } from './workspace-proxy-build'

describe('workspaceProxyBuild scope', () => {
  it.each(['/source/worker.ts', '\0virtual:another-entry:test', '/source/virtual:alchemy-entry:test'])(
    'does not inject the SDK into unrelated module %s',
    async (id) => {
      const result = await build({
        configFile: false,
        logLevel: 'silent',
        plugins: [
          workspaceProxyBuild(),
          {
            name: 'workspace-proxy-scope-fixture',
            resolveId(source) {
              return source === 'workspace-proxy-scope-fixture' ? id : null
            },
            load(source) {
              return source === id ? 'export const value = 1' : null
            },
          },
        ],
        build: {
          target: 'esnext',
          write: false,
          outDir: fileURLToPath(new URL('../../../../../tmp/workspace-proxy-scope-build', import.meta.url)),
          rolldownOptions: {
            input: 'workspace-proxy-scope-fixture',
            preserveEntrySignatures: 'strict',
            output: { format: 'es' },
          },
        },
      })
      const output = Array.isArray(result) ? result[0] : result
      if (!output || !('output' in output)) throw new Error('Expected fixture output')
      const entry = Array.findFirst(output.output, (chunk) => chunk.type === 'chunk' && chunk.isEntry)
      if (entry._tag === 'None' || entry.value.type !== 'chunk') throw new Error('Expected fixture entry')
      expect(entry.value.exports).toEqual(['value'])
      expect(entry.value.code).not.toContain('WorkspaceProxy')
    },
  )
})
