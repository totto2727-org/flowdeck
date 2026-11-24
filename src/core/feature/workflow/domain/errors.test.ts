import { expect, expectTypeOf, test } from 'vite-plus/test'

import { Conflict, ExternalError, StorageConflict } from './errors.ts'

test('represents a domain conflict without an external cause', () => {
  expectTypeOf<ConstructorParameters<typeof Conflict>[0]>().toEqualTypeOf<Readonly<{ message: string }>>()
  const error = new Conflict({ message: 'Event IDs must be unique' })
  expect(error.message).toBe('Event IDs must be unique')
  expect(error).not.toHaveProperty('cause')
})

test('requires the original cause and operation for storage conflicts', () => {
  expectTypeOf<ConstructorParameters<typeof StorageConflict>[0]>().toEqualTypeOf<
    Readonly<{
      message: string
      operation: string
      cause: unknown
    }>
  >()
  const cause = new Error('UNIQUE constraint failed')
  const error = new StorageConflict({ message: cause.message, operation: 'batch', cause })
  expect(error.cause).toBe(cause)
  expect(error.operation).toBe('batch')
})

test('requires the original cause for external failures', () => {
  expectTypeOf<ConstructorParameters<typeof ExternalError>[0]>().toEqualTypeOf<
    Readonly<{
      operation: string
      kind: 'storage' | 'service'
      cause: unknown
    }>
  >()
  const cause = new Error('Database unavailable')
  const error = new ExternalError({ operation: 'get run', kind: 'storage', cause })
  expect(error.cause).toBe(cause)
})
