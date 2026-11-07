import { Effect, Schema } from 'effect'

import { JsonObject } from '../../../features/workflow/domain/model'
import type { WorkflowDefinition } from '../../../features/workflow/services/workflow-definition'
import {
  DevelopmentSnapshotJson,
  developmentGraphFor,
  developmentWorkflow,
  initialDevelopmentSnapshot,
} from './development'
import { DevelopmentCreateRun } from './input'

export { DevelopmentCreateRun, DevelopmentTask, PublicRepository } from './input'

const PreparationInput = Schema.Struct({
  ...DevelopmentCreateRun.fields,
  // Routing has decoded the envelope's SemVer. Workflow-specific URL input is decoded here.
  repository: Schema.toCodecJson(DevelopmentCreateRun.fields.repository),
})

const decodePreparationInput = Schema.decodeUnknownEffect(PreparationInput)
const encodeSnapshot = Schema.encodeSync(DevelopmentSnapshotJson)
const decodeJsonObject = Schema.decodeUnknownSync(JsonObject)

export const developmentDefinition: WorkflowDefinition = {
  summary: developmentWorkflow,
  prepare: (input) =>
    decodePreparationInput(input, { onExcessProperty: 'error' }).pipe(
      Effect.map((validated) => ({
        graph: developmentGraphFor(validated.version),
        snapshot: decodeJsonObject(encodeSnapshot(initialDevelopmentSnapshot(validated))),
      })),
    ),
}
