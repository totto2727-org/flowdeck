import { layer } from '@effect/vitest'
import { Array, Effect, Predicate } from 'effect'
import { expect } from 'vite-plus/test'

import { SourceOwnership } from './fixtures/source-ownership.ts'
import type { SourceInventory } from './fixtures/source-ownership.ts'

const bridgeRole = (inventory: SourceInventory, target: string): string | undefined => {
  const [category, , role] = inventory.directories(target)
  return category === 'bridge' ? role : undefined
}
const allowedRoles = ['bridge', 'core', 'user-land']
const recognized = (inventory: SourceInventory, target: string): boolean => {
  const role = bridgeRole(inventory, target)
  return (
    inventory.within(target, 'share') ||
    inventory.within(target, 'core') ||
    inventory.within(target, 'user-land') ||
    (Predicate.isNotNullish(role) && Array.contains(allowedRoles, role))
  )
}
const isCore = (inventory: SourceInventory, target: string): boolean =>
  inventory.within(target, 'core') || bridgeRole(inventory, target) === 'core'
const coreTarget = (inventory: SourceInventory, target: string): boolean =>
  isCore(inventory, target) || inventory.within(target, 'share')

layer(SourceOwnership.layer)('source ownership boundaries', (it) => {
  it.effect('classifies every source as share, core, a worker bridge, or user-land', () =>
    Effect.gen(function* () {
      const inventory = yield* SourceOwnership
      expect(inventory.files).not.toHaveLength(0)
      expect(Array.filter(inventory.files, (file) => !recognized(inventory, file))).toStrictEqual([])
    }),
  )

  it.effect('keeps share independent from core, bridges, and user-land', () =>
    Effect.gen(function* () {
      const { dependencies, files, within } = yield* SourceOwnership
      const shared = Array.filter(dependencies, ({ file }) => within(file, 'share'))
      expect(Array.filter(files, (file) => within(file, 'share'))).not.toHaveLength(0)
      expect(Array.filter(shared, ({ target }) => !within(target, 'share'))).toStrictEqual([])
    }),
  )

  it.effect('forbids core imports of user-land and bridge integration', () =>
    Effect.gen(function* () {
      const inventory = yield* SourceOwnership
      // Test files carry architecture dependencies too, including type imports and re-exports.
      const core = Array.filter(inventory.dependencies, ({ file }) => isCore(inventory, file))
      expect(core).not.toHaveLength(0)
      expect(Array.filter(core, ({ target }) => !coreTarget(inventory, target))).toStrictEqual([])
    }),
  )
})

const rules = [
  { allowed: ['core/feature', 'share'], directory: 'core/feature' },
  { allowed: ['core/feature/d1'], directory: 'core/feature/d1' },
  {
    allowed: ['core/feature/workflow/rpc', 'core/feature/workflow/domain'],
    directory: 'core/feature/workflow/rpc',
  },
  { allowed: ['core/feature/cluster', 'core/feature/d1'], directory: 'core/feature/cluster' },
  {
    allowed: ['core/feature/workflow/domain', 'share/feature/identity'],
    directory: 'core/feature/workflow/domain',
  },
]
const belongsToProduction = (inventory: SourceInventory, file: string, directory: string): boolean =>
  !file.endsWith('.test.ts') && inventory.within(file, directory)

layer(SourceOwnership.layer)('production source dependency rules', (it) => {
  it.effect.each(rules)('limits $directory to the declared dependency scopes', ({ allowed, directory }) =>
    Effect.gen(function* () {
      const inventory = yield* SourceOwnership
      const dependencies = Array.filter(inventory.dependencies, ({ file }) =>
        belongsToProduction(inventory, file, directory),
      )
      expect(dependencies).not.toHaveLength(0)
      expect(
        Array.filter(dependencies, ({ target }) => !Array.some(allowed, (rule) => inventory.within(target, rule))),
      ).toStrictEqual([])
    }),
  )
})

layer(SourceOwnership.layer)('source import syntax', (it) => {
  it.effect('reads every supported import syntax as an architecture dependency', () =>
    Effect.gen(function* () {
      const inventory = yield* SourceOwnership
      const targets = inventory.probe()
      expect(targets).toHaveLength(6)
      expect(Array.filter(targets, ({ target }) => coreTarget(inventory, target))).toStrictEqual([])
      expect(Array.map(targets, ({ target }) => inventory.relative(target))).toStrictEqual([
        'user-land/definition',
        'user-land/value',
        'bridge/workflow/bridge/worker',
        'user-land/exported',
        'user-land/type',
        'user-land/lazy',
      ])
    }),
  )
})
