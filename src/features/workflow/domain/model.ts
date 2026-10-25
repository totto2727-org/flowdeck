import { Result, Schema } from 'effect'

import { UserDefinedId } from '../../identity/id'

const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))

const decodeSemVer = Schema.decodeUnknownResult(Schema.SemVerFromString)
/** Validate once with the official codec while preserving the public string representation. */
export const WorkflowVersion = Schema.String.check(Schema.makeFilter((value) => Result.isSuccess(decodeSemVer(value))))
export type WorkflowVersion = typeof WorkflowVersion.Type
export const RunStatus = Schema.Literals(['pending', 'running', 'waiting', 'completed', 'failed'])
export type RunStatus = typeof RunStatus.Type
export const JsonObject = Schema.Record(Schema.String, Schema.Unknown)

export const GraphNode = Schema.Struct({
  nodeId: UserDefinedId,
  label: Schema.String,
  kind: Schema.Literals(['task', 'checkpoint']),
})
export type GraphNode = typeof GraphNode.Type
export const GraphEdge = Schema.Struct({
  edgeId: UserDefinedId,
  source: UserDefinedId,
  target: UserDefinedId,
  label: Schema.String,
})
export type GraphEdge = typeof GraphEdge.Type
export const GraphDefinition = Schema.Struct({
  graphId: Schema.String,
  schemaVersion: Schema.Literal(1),
  nodes: Schema.Array(GraphNode),
  edges: Schema.Array(GraphEdge),
})
export type GraphDefinition = typeof GraphDefinition.Type

export const WorkflowSummary = Schema.Struct({
  workflowId: UserDefinedId,
  name: Schema.String,
  versions: Schema.Array(WorkflowVersion),
  inputs: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      label: Schema.String,
      kind: Schema.Literals(['text', 'textarea']),
      required: Schema.Boolean,
      placeholder: Schema.optional(Schema.String),
      maxLength: PositiveInt,
    }),
  ),
})
export type WorkflowSummary = typeof WorkflowSummary.Type
export const Run = Schema.Struct({
  runId: Schema.String,
  workflowId: Schema.String,
  // Persisted histories can contain pre-SemVer workflow-owned versions such as v1/v2.
  workflowVersion: Schema.String.check(Schema.isMinLength(1)),
  graphId: Schema.String,
  status: RunStatus,
  revision: Revision,
  snapshot: Schema.Unknown,
  createdAt: Schema.String,
  updatedAt: Schema.String,
})
export type Run = typeof Run.Type
export const RunState = Schema.Struct({
  runId: Schema.String,
  revision: Revision,
  snapshot: Schema.Unknown,
})
export type RunState = typeof RunState.Type
export const EventType = Schema.Literals([
  'run.started',
  'node.started',
  'node.succeeded',
  'node.failed',
  'run.waiting',
  'run.resumed',
  'run.completed',
  'run.failed',
])
export type EventType = typeof EventType.Type
export const RunEvent = Schema.Struct({
  eventId: Schema.String,
  runId: Schema.String,
  sequence: PositiveInt,
  nodeId: Schema.NullOr(Schema.String),
  executionId: Schema.NullOr(Schema.String),
  attempt: Schema.NullOr(PositiveInt),
  type: EventType,
  payload: JsonObject,
  createdAt: Schema.String,
})
export type RunEvent = typeof RunEvent.Type
export const NodeVisualState = Schema.Literals(['idle', 'running', 'succeeded', 'failed', 'waiting'])
export type NodeVisualState = typeof NodeVisualState.Type
export const NodeShape = Schema.Struct({
  id: Schema.String,
  nodeId: UserDefinedId,
  type: Schema.Literal('node'),
  label: Schema.String,
  kind: Schema.Literals(['task', 'checkpoint']),
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
  state: NodeVisualState,
})
export const EdgeShape = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal('edge'),
  source: UserDefinedId,
  target: UserDefinedId,
  label: Schema.String,
  traversed: Schema.Boolean,
})
export const Shapes = Schema.Struct({ nodes: Schema.Array(NodeShape), edges: Schema.Array(EdgeShape) })
export type Shapes = typeof Shapes.Type
export const RunDetail = Schema.Struct({
  run: Run,
  graph: GraphDefinition,
  state: RunState,
  events: Schema.Array(RunEvent),
  shapes: Shapes,
})
export type RunDetail = typeof RunDetail.Type
/** Routing envelope only. The selected workflow validates all remaining input fields. */
export const CreateRun = Schema.StructWithRest(Schema.Struct({ workflowId: UserDefinedId, version: WorkflowVersion }), [
  Schema.Record(Schema.String, Schema.Unknown),
])
export type CreateRun = typeof CreateRun.Type
export const WorkflowsResponse = Schema.Struct({ workflows: Schema.Array(WorkflowSummary) })
export const RunsResponse = Schema.Struct({ runs: Schema.Array(Run) })
export const ApiErrorResponse = Schema.Struct({ error: Schema.String, message: Schema.String })
