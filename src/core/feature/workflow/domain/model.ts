import { Schema, Tuple } from 'effect'

import { EdgeId, EventId, ExecutionId, GraphId, NodeId, RunId, WorkflowId } from './identity.ts'

const minimumCount = 0
const graphSchemaVersion = 1
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(minimumCount))
export const PositiveInt = Schema.Int.check(Schema.isGreaterThan(minimumCount))

// oxlint-disable-next-line eslint/no-redeclare -- The exported schema value and corresponding Type share this public name.
export const WorkflowVersion = Schema.SemVer
export type WorkflowVersion = typeof WorkflowVersion.Type
// oxlint-disable-next-line eslint/no-redeclare -- The exported schema value and corresponding Type share this public name.
export const RunStatus = Schema.Literals(['pending', 'running', 'waiting', 'completed', 'failed'])
export type RunStatus = typeof RunStatus.Type
// oxlint-disable-next-line eslint/no-redeclare -- The exported schema value and corresponding Type share this public name.
export const { JsonObject } = Schema
export type JsonObject = typeof JsonObject.Type

// oxlint-disable-next-line eslint/no-redeclare, eslint/sort-keys -- Keep the public schema and type and the exact graph JSON order required by the immutable D1 graph trigger.
export const GraphNode = Schema.Struct({
  nodeId: NodeId,
  label: Schema.String,
  kind: Schema.Literals(['task', 'checkpoint']),
})
export type GraphNode = typeof GraphNode.Type
// oxlint-disable-next-line eslint/no-redeclare, eslint/sort-keys -- Keep the public schema and type and the exact graph JSON order required by the immutable D1 graph trigger.
export const GraphEdge = Schema.Struct({
  edgeId: EdgeId,
  source: NodeId,
  target: NodeId,
  label: Schema.String,
})
export type GraphEdge = typeof GraphEdge.Type
// oxlint-disable-next-line eslint/no-redeclare, eslint/sort-keys -- Keep the public schema and type and the exact graph JSON order required by the immutable D1 graph trigger.
export const GraphDefinition = Schema.Struct({
  graphId: GraphId,
  schemaVersion: Schema.Literal(graphSchemaVersion),
  nodes: Schema.Array(GraphNode),
  edges: Schema.Array(GraphEdge),
})
export type GraphDefinition = typeof GraphDefinition.Type

const WorkflowInput = Schema.Struct({
  kind: Schema.Literals(['text', 'textarea']),
  label: Schema.String,
  maxLength: PositiveInt,
  name: Schema.String,
  placeholder: Schema.optional(Schema.String),
  required: Schema.Boolean,
})
// oxlint-disable-next-line eslint/no-redeclare -- The exported schema value and corresponding Type share this public name.
export const WorkflowSummary = Schema.Struct({
  inputs: Schema.Array(WorkflowInput),
  name: Schema.String,
  versions: Schema.Array(WorkflowVersion),
  workflowId: WorkflowId,
})
export type WorkflowSummary = typeof WorkflowSummary.Type
// oxlint-disable-next-line eslint/no-redeclare -- The exported schema value and corresponding Type share this public name.
export const Run = Schema.Struct({
  createdAt: Schema.DateTimeUtc,
  graphId: GraphId,
  revision: Revision,
  runId: RunId,
  snapshot: JsonObject,
  status: RunStatus,
  updatedAt: Schema.DateTimeUtc,
  workflowId: WorkflowId,
  workflowVersion: WorkflowVersion,
})
export type Run = typeof Run.Type
// oxlint-disable-next-line eslint/no-redeclare -- The exported schema value and corresponding Type share this public name.
export const RunState = Schema.Struct({
  revision: Revision,
  runId: RunId,
  snapshot: JsonObject,
})
export type RunState = typeof RunState.Type
// oxlint-disable-next-line eslint/no-redeclare -- The exported schema value and corresponding Type share this public name.
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
// oxlint-disable-next-line eslint/sort-keys -- D1 matches retried commits against the exact serialized event property order.
export const EventFields = {
  eventId: EventId,
  payload: JsonObject,
  createdAt: Schema.DateTimeUtc,
}
// oxlint-disable-next-line eslint/sort-keys -- D1 matches retried commits against the exact serialized event property order.
export const NodeEventFields = {
  nodeId: NodeId,
  executionId: ExecutionId,
  attempt: PositiveInt,
}
/** Each event type determines whether a node execution is part of its identity. */
// oxlint-disable-next-line eslint/no-redeclare -- The exported schema value and corresponding Type share this public name.
export const PendingRunEvent = Schema.Union([
  Schema.Struct({ ...EventFields, type: Schema.Literal('run.started') }),
  Schema.Struct({ ...EventFields, type: Schema.Literal('run.resumed') }),
  Schema.Struct({ ...EventFields, type: Schema.Literal('run.completed') }),
  Schema.Struct({ ...EventFields, type: Schema.Literal('run.failed') }),
  Schema.Struct({ ...EventFields, ...NodeEventFields, type: Schema.Literal('run.waiting') }),
  Schema.Struct({ ...EventFields, ...NodeEventFields, type: Schema.Literal('node.started') }),
  Schema.Struct({ ...EventFields, ...NodeEventFields, type: Schema.Literal('node.succeeded') }),
  Schema.Struct({ ...EventFields, ...NodeEventFields, type: Schema.Literal('node.failed') }),
])
export type PendingRunEvent = typeof PendingRunEvent.Type
// oxlint-disable-next-line eslint/no-redeclare -- The exported schema value and corresponding Type share this public name.
export const RunEvent = PendingRunEvent.mapMembers(
  Tuple.map(Schema.fieldsAssign({ runId: RunId, sequence: PositiveInt })),
)
export type RunEvent = typeof RunEvent.Type
// oxlint-disable-next-line eslint/no-redeclare -- The exported schema value and corresponding Type share this public name.
export const NodeVisualState = Schema.Literals(['idle', 'running', 'succeeded', 'failed', 'waiting'])
export type NodeVisualState = typeof NodeVisualState.Type
// oxlint-disable-next-line eslint/no-redeclare -- The exported schema value and corresponding Type share this public name.
export const Position = Schema.Struct({ x: Schema.Number, y: Schema.Number })
export type Position = typeof Position.Type
// oxlint-disable-next-line eslint/no-redeclare -- The exported schema value and corresponding Type share this public name.
export const Size = Schema.Struct({ height: Schema.Number, width: Schema.Number })
export type Size = typeof Size.Type
export const NodeShape = Schema.Struct({
  id: NodeId,
  kind: Schema.Literals(['task', 'checkpoint']),
  label: Schema.String,
  nodeId: NodeId,
  position: Position,
  size: Size,
  state: NodeVisualState,
  type: Schema.Literal('node'),
})
export const EdgeShape = Schema.Struct({
  id: EdgeId,
  label: Schema.String,
  source: NodeId,
  target: NodeId,
  traversed: Schema.Boolean,
  type: Schema.Literal('edge'),
})
// oxlint-disable-next-line eslint/no-redeclare -- The exported schema value and corresponding Type share this public name.
export const Shapes = Schema.Struct({ edges: Schema.Array(EdgeShape), nodes: Schema.Array(NodeShape) })
export type Shapes = typeof Shapes.Type
// oxlint-disable-next-line eslint/no-redeclare -- The exported schema value and corresponding Type share this public name.
export const RunDetail = Schema.Struct({
  events: Schema.Array(RunEvent),
  graph: GraphDefinition,
  run: Run,
  shapes: Shapes,
  state: RunState,
})
export type RunDetail = typeof RunDetail.Type
const WorkflowInputKey = Schema.String.check(Schema.makeFilter((key) => key !== 'workflowId' && key !== 'version'))
const RoutingEnvelope = Schema.Struct({ version: WorkflowVersion, workflowId: WorkflowId })
const workflowInput = Schema.Record(WorkflowInputKey, Schema.Unknown)
/** Routing validates the envelope and leaves additional fields to the selected workflow. */
// oxlint-disable-next-line eslint/no-redeclare -- The exported schema value and corresponding Type share this public name.
export const CreateRun = Schema.StructWithRest(RoutingEnvelope, [workflowInput])
export type CreateRun = typeof CreateRun.Type
export const WorkflowsResponse = Schema.Struct({ workflows: Schema.Array(WorkflowSummary) })
export const RunsResponse = Schema.Struct({ runs: Schema.Array(Run) })
export const ApiErrorResponse = Schema.Struct({ error: Schema.String, message: Schema.String })
