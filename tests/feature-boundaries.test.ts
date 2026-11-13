import { globSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import { Array, String } from 'effect'
import { isStringLiteralLikeNode } from 'typescript/ast'
import { API } from 'typescript/sync'
import { describe, expect, it } from 'vite-plus/test'

const sourceRoot = resolve('src')
const sources = Array.map(globSync('src/**/*.{ts,tsx}'), (file) => resolve(file))
const within = (target: string, directory: string) => {
  const root = resolve(sourceRoot, directory)
  return target === root || target.startsWith(`${root}${sep}`)
}
const bridgeCore = (target: string) => {
  const parts = String.split(relative(sourceRoot, target), sep)
  return parts[0] === 'bridge' && parts[2] === 'core'
}
const localTarget = (file: string, specifier: string) =>
  specifier.startsWith('@/')
    ? resolve(sourceRoot, specifier.slice(2))
    : specifier.startsWith('.')
      ? resolve(dirname(file), specifier)
      : isAbsolute(specifier)
        ? specifier
        : undefined

const parseDependencies = (compiler: API, file: string, text: string) => {
  using lease = compiler.createSourceFile(file, text)
  return Array.flatMap(lease.sourceFile.imports, (node) => {
    if (!isStringLiteralLikeNode(node)) return []
    const target = localTarget(file, node.text)
    return target === undefined ? [] : [{ file, target }]
  })
}
const dependencies = (() => {
  using compiler = new API()
  return Array.flatMap(sources, (file) => parseDependencies(compiler, file, readFileSync(file, 'utf8')))
})()
const coreTarget = (target: string) => within(target, 'core') || within(target, 'share') || bridgeCore(target)
const coreDependencies = Array.filter(dependencies, ({ file }) => within(file, 'core') || bridgeCore(file))
const productionDependencies = Array.filter(dependencies, ({ file }) => !file.endsWith('.test.ts'))
const featureDependencies = Array.filter(productionDependencies, ({ file }) => within(file, 'core/feature'))

// Check tests too: application integration tests belong under tests/, not core.
// Type-only imports, dynamic imports, and re-exports all carry architecture dependencies.
describe('source ownership boundaries', () => {
  it('classifies every source as share, core, a worker bridge, or user-land', () => {
    expect(sources).not.toHaveLength(0)
    expect(
      Array.filter(sources, (file) => {
        const parts = String.split(relative(sourceRoot, file), sep)
        return !(
          within(file, 'share') ||
          within(file, 'core') ||
          within(file, 'user-land') ||
          (parts[0] === 'bridge' && Array.contains(['core', 'bridge', 'user-land'], parts[2] ?? ''))
        )
      }),
    ).toEqual([])
  })

  it('keeps share independent from core, bridges, and user-land', () => {
    const shared = Array.filter(dependencies, ({ file }) => within(file, 'share'))
    expect(Array.filter(sources, (file) => within(file, 'share'))).not.toHaveLength(0)
    expect(Array.filter(shared, ({ target }) => !within(target, 'share'))).toEqual([])
  })

  it('forbids core imports of user-land and bridge integration, including indirect entry points', () => {
    expect(coreDependencies).not.toHaveLength(0)
    expect(Array.filter(coreDependencies, ({ target }) => !coreTarget(target))).toEqual([])
  })

  it('keeps reusable core features independent from concrete Worker resources', () => {
    expect(featureDependencies).not.toHaveLength(0)
    expect(
      Array.filter(featureDependencies, ({ target }) => !within(target, 'core/feature') && !within(target, 'share')),
    ).toEqual([])
  })

  it('keeps D1 execution independent from workflow policy and application resources', () => {
    const d1 = Array.filter(productionDependencies, ({ file }) => within(file, 'core/feature/d1'))
    expect(d1).not.toHaveLength(0)
    expect(Array.filter(d1, ({ target }) => !within(target, 'core/feature/d1'))).toEqual([])
  })

  it('keeps the workflow RPC protocol independent from persistence and concrete Workers', () => {
    const rpc = Array.filter(productionDependencies, ({ file }) => within(file, 'core/feature/workflow/rpc'))
    expect(rpc).not.toHaveLength(0)
    expect(
      Array.filter(
        rpc,
        ({ target }) => !within(target, 'core/feature/workflow/rpc') && !within(target, 'core/feature/workflow/domain'),
      ),
    ).toEqual([])
  })

  it('keeps Cluster checkpoint storage independent from workflow policy and application resources', () => {
    const cluster = Array.filter(productionDependencies, ({ file }) => within(file, 'core/feature/cluster'))
    expect(cluster).not.toHaveLength(0)
    expect(
      Array.filter(
        cluster,
        ({ target }) => !within(target, 'core/feature/cluster') && !within(target, 'core/feature/d1'),
      ),
    ).toEqual([])
  })

  it('keeps workflow domain values independent from services and transport', () => {
    const domain = Array.filter(productionDependencies, ({ file }) => within(file, 'core/feature/workflow/domain'))
    expect(domain).not.toHaveLength(0)
    expect(
      Array.filter(
        domain,
        ({ target }) => !within(target, 'core/feature/workflow/domain') && !within(target, 'share/feature/identity'),
      ),
    ).toEqual([])
  })

  it('parses every supported import form instead of allowing type, re-export, or lazy-import bypasses', () => {
    using compiler = new API()
    const targets = parseDependencies(
      compiler,
      resolve(sourceRoot, 'core/feature/boundary-probe.ts'),
      `import type { Definition } from '@/user-land/definition'
       import { value } from '../../user-land/value'
       export { handler } from '@/bridge/workflow/bridge/worker'
       export * from '@/user-land/exported'
       type Remote = import('@/user-land/type').Remote
       const load = () => import('@/user-land/lazy')`,
    )
    expect(targets).toHaveLength(6)
    expect(Array.filter(targets, ({ target }) => coreTarget(target))).toEqual([])
    expect(Array.map(targets, ({ target }) => relative(sourceRoot, target))).toEqual([
      'user-land/definition',
      'user-land/value',
      'bridge/workflow/bridge/worker',
      'user-land/exported',
      'user-land/type',
      'user-land/lazy',
    ])
  })
})
