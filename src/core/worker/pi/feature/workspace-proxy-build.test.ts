// oxlint-disable-next-line rules/no-node-imports -- Vite requires a decoded native filesystem path for the isolated fixture output folder.
import { fileURLToPath } from 'node:url'

import { Array, Data, Option, Predicate } from 'effect'
import { build } from 'vite-plus'
import type { Plugin } from 'vite-plus'
import { describe, expect, test } from 'vite-plus/test'

import { workspaceProxyBuild } from './workspace-proxy-build.ts'

const fixtureId = 'workspace-proxy-scope-fixture'
const outDir = fileURLToPath(new URL('../../../../../tmp/workspace-proxy-scope-build', import.meta.url))
// oxlint-disable-next-line unicorn/no-null -- A Rolldown hook returns null to defer unrelated modules to other plugins.
const unchanged = null

const sourceFor = (id: string): Plugin => ({
  load: (source) => (source === id ? 'export const value = 1' : unchanged),
  name: fixtureId,
  resolveId: (source) => (source === fixtureId ? id : unchanged),
})

class MissingFixtureBundle extends Data.TaggedError('MissingFixtureBundle')<{ message: string }> {}

type BundleEntry = Readonly<{ code: string; exports: string[] }>
const compileUnrelatedModule = async (id: string): Promise<BundleEntry> => {
  const output = await build({
    build: {
      outDir,
      rolldownOptions: {
        input: fixtureId,
        output: { format: 'es' },
        preserveEntrySignatures: 'strict',
      },
      target: 'esnext',
      write: false,
    },
    configFile: false,
    logLevel: 'silent',
    plugins: [workspaceProxyBuild(), sourceFor(id)],
  })
  const artifact = Array.isArray(output) ? Option.getOrUndefined(Array.head(output)) : output
  if (Predicate.isNullish(artifact) || !('output' in artifact)) {
    throw new MissingFixtureBundle({ message: 'Expected fixture output' })
  }
  const chunks = Array.filter(artifact.output, (chunk) => chunk.type === 'chunk')
  const entry = Array.findFirst(chunks, (chunk) => chunk.isEntry)
  return Option.getOrThrowWith(entry, () => new MissingFixtureBundle({ message: 'Expected fixture entry' }))
}

describe('workspaceProxyBuild scope', () => {
  test.each(['/source/worker.ts', '\0virtual:another-entry:test', '/source/virtual:alchemy-entry:test'])(
    'leaves unrelated module %s without the SDK export',
    async (id) => {
      const entry = await compileUnrelatedModule(id)
      expect(entry.exports).toStrictEqual(['value'])
      expect(entry.code).not.toContain('WorkspaceProxy')
    },
  )
})
