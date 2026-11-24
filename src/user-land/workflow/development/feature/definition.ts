import { Effect, Schema } from 'effect'

import { JsonObject } from '@/core/feature/workflow/domain/model'
import type { WorkflowDefinition } from '@/core/feature/workflow/services/workflow-definition'

import {
  DevelopmentSnapshotJson,
  developmentGraphFor,
  developmentWorkflow,
  initialDevelopmentSnapshot,
} from './development.ts'
import { DevelopmentCreateRun } from './input.ts'

export { DevelopmentCreateRun, DevelopmentTask, PublicRepository } from './input.ts'

const PreparationInput = Schema.Struct({
  ...DevelopmentCreateRun.fields,
  // Routing has decoded the envelope's SemVer. Workflow-specific URL input is decoded here.
  repository: Schema.toCodecJson(DevelopmentCreateRun.fields.repository),
})

// oxlint-disable-next-line rules/prefer-non-unknown-decode -- Routing has not typed the workflow's repository URL and task fields.
const decodePreparationInput = Schema.decodeUnknownEffect(PreparationInput)
const encodeSnapshot = Schema.encodeEffect(DevelopmentSnapshotJson)
const decodeJsonObject = Schema.decodeUnknownResult(JsonObject)

export const developmentDefinition: WorkflowDefinition = {
  prepare: (input) =>
    decodePreparationInput(input, { onExcessProperty: 'error' }).pipe(
      Effect.flatMap((validated) =>
        Effect.gen(function* () {
          const graph = developmentGraphFor(validated.version)
          const initial = yield* initialDevelopmentSnapshot(validated)
          const encoded = yield* encodeSnapshot(initial).pipe(Effect.orDie)
          const snapshot = yield* Effect.fromResult(decodeJsonObject(encoded)).pipe(Effect.orDie)
          return { graph, snapshot }
        }),
      ),
    ),
  summary: developmentWorkflow,
}
