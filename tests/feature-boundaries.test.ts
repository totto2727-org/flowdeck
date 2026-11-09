import { globSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { Array } from 'effect'
import { isStringLiteralLikeNode } from 'typescript/ast'
import { API } from 'typescript/sync'
import { describe, expect, it } from 'vite-plus/test'

const sources = Array.map(globSync('src/features/**/*.ts', { exclude: ['**/*.test.ts'] }), (file) => `/${file}`)
const sourceRoot = resolve('src')

const localTarget = (file: string, specifier: string) =>
  specifier.startsWith('@/')
    ? resolve(sourceRoot, specifier.slice(2))
    : specifier.startsWith('.')
      ? resolve(dirname(resolve(file.slice(1))), specifier)
      : undefined

const dependencies = (() => {
  using compiler = new API()
  return Array.flatMap(sources, (file) => {
    using lease = compiler.createSourceFile(resolve(file.slice(1)), readFileSync(file.slice(1), 'utf8'))
    return Array.flatMap(lease.sourceFile.imports, (node) => {
      if (!isStringLiteralLikeNode(node)) return []
      const target = localTarget(file, node.text)
      return target === undefined ? [] : [{ file, target }]
    })
  })
})()

const within = (target: string, directory: string) => target.startsWith(`${resolve(sourceRoot, directory)}/`)

// Imports are part of the capability contract, including type-only and dynamic imports.
// The compiler parses them so multiline imports, comments, and re-exports need no custom parser.
describe('shared feature boundaries', () => {
  it('keeps shared features independent from application Worker resources', () => {
    expect(Array.filter(dependencies, ({ target }) => within(target, 'workers'))).toEqual([])
  })

  it('keeps D1 execution independent from workflow policy and application resources', () => {
    const d1 = Array.filter(dependencies, ({ file }) => file.startsWith('/src/features/d1/'))
    expect(Array.filter(sources, (file) => file.startsWith('/src/features/d1/'))).not.toHaveLength(0)
    expect(d1).not.toHaveLength(0)
    expect(Array.filter(d1, ({ target }) => !within(target, 'features/d1'))).toEqual([])
  })

  it('keeps the workflow RPC protocol independent from persistence and concrete Workers', () => {
    const rpc = Array.filter(dependencies, ({ file }) => file.startsWith('/src/features/workflow/rpc/'))
    expect(rpc).not.toHaveLength(0)
    expect(
      Array.filter(
        rpc,
        ({ target }) => !within(target, 'features/workflow/rpc') && !within(target, 'features/workflow/domain'),
      ),
    ).toEqual([])
  })

  it('keeps Cluster checkpoint storage independent from workflow policy and application resources', () => {
    const cluster = Array.filter(dependencies, ({ file }) => file.startsWith('/src/features/cluster/'))
    expect(cluster).not.toHaveLength(0)
    expect(
      Array.filter(cluster, ({ target }) => !within(target, 'features/cluster') && !within(target, 'features/d1')),
    ).toEqual([])
  })

  it('keeps workflow domain values independent from services and transport', () => {
    const domain = Array.filter(dependencies, ({ file }) => file.startsWith('/src/features/workflow/domain/'))
    expect(domain).not.toHaveLength(0)
    expect(
      Array.filter(
        domain,
        ({ target }) => !within(target, 'features/workflow/domain') && !within(target, 'features/identity'),
      ),
    ).toEqual([])
  })
})
