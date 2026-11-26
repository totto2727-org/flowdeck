import { Array, Effect, MutableRef, Record, Schema } from 'effect'

import type { Session, TurnReceipt, TurnRequest } from '@/core/feature/pi/model'
import type { PiSandbox } from '@/core/feature/pi/sandbox'
import { ExternalError } from '@/core/feature/workflow/domain/errors'
import { ExecutionId } from '@/core/feature/workflow/domain/identity'
import type { Run } from '@/core/feature/workflow/domain/model'
import type { StoreService } from '@/core/feature/workflow/services/store'
import { DevelopmentStates } from '@/user-land/workflow/development/feature/development-machine'

import { activeOperation, nativeSnapshot } from './development-snapshot.fixture.ts'

type Submission = Readonly<{ input: TurnRequest; runId: Run['runId'] }>
type HarnessState = Readonly<{
  completeCalls: Readonly<Run['runId'][]>
  ensureCalls: number
  receipts: Record<string, TurnReceipt>
  session: Session
  submissions: Readonly<Submission[]>
}>
type StateRef = MutableRef.MutableRef<HarnessState>
type Sandbox = typeof PiSandbox.Service

const external = (operation: string, cause: unknown): ExternalError =>
  new ExternalError({ cause, kind: 'service', operation })

const checkSubmission = Effect.fn('flowdeck.test.checkPersistedTurn')(function* (
  store: StoreService,
  runId: Run['runId'],
  request: TurnRequest,
) {
  const current = yield* store.getRun(runId)
  const native = yield* nativeSnapshot(current.snapshot)
  const intent = activeOperation(native)
  const permitted =
    DevelopmentStates.matches(native, 'implement.intent') || DevelopmentStates.matches(native, 'verify.intent')
  if (
    current.status !== 'running' ||
    request.commandId !== intent.commandId ||
    !Schema.is(ExecutionId)(intent.executionId) ||
    !permitted
  ) {
    yield* external('test binding', 'Pi was called before the matching intent was persisted.')
  }
})

const submit = (state: StateRef, store: StoreService): Sandbox['submitTurn'] =>
  Effect.fn('flowdeck.test.submitPiTurn')(
    function* (runId, input) {
      yield* checkSubmission(store, runId, input)
      const receipt = { commandId: input.commandId, status: 'running' } satisfies TurnReceipt
      MutableRef.update(state, (current) => ({
        ...current,
        receipts: Record.set(current.receipts, input.commandId, receipt),
        submissions: Array.append(current.submissions, { input, runId }),
      }))
      return receipt
    },
    Effect.mapError((cause) => external('test binding', cause)),
  )

const currentSession = (state: StateRef): Session => MutableRef.get(state).session

const oneEnsureCall = 1

const makeSandbox = (state: StateRef, store: StoreService): Sandbox => ({
  complete: (runId) =>
    Effect.sync(() => {
      const next = MutableRef.updateAndGet(state, (current) => ({
        ...current,
        completeCalls: Array.append(current.completeCalls, runId),
        session: { ...current.session, status: 'completed' as const },
      }))
      return next.session
    }),
  ensureSession: () =>
    Effect.sync(() => {
      MutableRef.update(state, (current) => ({ ...current, ensureCalls: current.ensureCalls + oneEnsureCall }))
      return currentSession(state)
    }),
  getTurn: (_runId, commandId) =>
    // oxlint-disable-next-line unicorn/no-null -- The Pi port represents an absent receipt with null.
    Effect.sync(() => MutableRef.get(state).receipts[commandId] ?? null),
  submitTurn: submit(state, store),
})

type PiHarness = Readonly<{
  clearReceipts: () => void
  finishTurn: (node: 'implement' | 'verify') => void
  read: () => HarnessState
  sandbox: () => Sandbox
  setReceipt: (key: string, receipt: TurnReceipt) => void
  setSandbox: (value: Sandbox) => void
  setSession: (value: Session) => void
}>

const firstTurnIndex = 0
const secondTurnIndex = 1

export const makePiHarness = (store: StoreService): PiHarness => {
  const state = MutableRef.make<HarnessState>({
    completeCalls: [],
    ensureCalls: 0,
    receipts: {},
    session: { model: 'test-model', sessionId: '1', status: 'active' },
    submissions: [],
  })
  const sandbox = MutableRef.make(makeSandbox(state, store))
  const setReceipt = (key: string, receipt: TurnReceipt): void => {
    MutableRef.update(state, (current) => ({ ...current, receipts: Record.set(current.receipts, key, receipt) }))
  }
  return {
    clearReceipts: (): void => {
      MutableRef.update(state, (current) => ({ ...current, receipts: {} }))
    },
    finishTurn: (node): void => {
      const position = node === 'implement' ? firstTurnIndex : secondTurnIndex
      const {
        input: { commandId },
      } = Array.getUnsafe(MutableRef.get(state).submissions, position)
      setReceipt(commandId, { commandId, status: 'completed', text: `${node} result` })
    },
    read: () => MutableRef.get(state),
    sandbox: () => MutableRef.get(sandbox),
    setReceipt,
    setSandbox: (value): void => {
      MutableRef.set(sandbox, value)
    },
    setSession: (value): void => {
      MutableRef.update(state, (current) => ({ ...current, session: value }))
    },
  }
}
