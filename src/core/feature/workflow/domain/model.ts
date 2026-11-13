import { Schema, Tuple } from 'effect'

import { EdgeId, EventId, ExecutionId, GraphId, NodeId, RunId, WorkflowId } from './identity'

const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))

export const WorkflowVersion = Schema.SemVer
export type WorkflowVersion = typeof WorkflowVersion.Type
export const RunStatus = Schema.Literals(['pending', 'running', 'waiting', 'completed', 'failed'])
export type RunStatus = typeof RunStatus.Type
export const JsonObject = Schema.JsonObject
export type JsonObject = typeof JsonObject.Type

export const GraphNode = Schema.Struct({
  nodeId: NodeId,
  label: Schema.String,
  kind: Schema.Literals(['task', 'checkpoint']),
})
export type GraphNode = typeof GraphNode.Type
export const GraphEdge = Schema.Struct({
  edgeId: EdgeId,
  source: NodeId,
  target: NodeId,
  label: Schema.String,
})
export type GraphEdge = typeof GraphEdge.Type
export const GraphDefinition = Schema.Struct({
  graphId: GraphId,
  schemaVersion: Schema.Literal(1),
  nodes: Schema.Array(GraphNode),
  edges: Schema.Array(GraphEdge),
})
export type GraphDefinition = typeof GraphDefinition.Type

export const WorkflowSummary = Schema.Struct({
  workflowId: WorkflowId,
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
  runId: RunId,
  workflowId: WorkflowId,
  workflowVersion: WorkflowVersion,
  graphId: GraphId,
  status: RunStatus,
  revision: Revision,
  snapshot: JsonObject,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
})
export type Run = typeof Run.Type
export const RunState = Schema.Struct({
  runId: RunId,
  revision: Revision,
  snapshot: JsonObject,
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
export const EventFields = {
  eventId: EventId,
  payload: JsonObject,
  createdAt: Schema.DateTimeUtc,
}
export const NodeEventFields = {
  nodeId: NodeId,
  executionId: ExecutionId,
  attempt: PositiveInt,
}
/** Each event type determines whether a node execution is part of its identity. */
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
export const RunEvent = PendingRunEvent.mapMembers(
  Tuple.map(Schema.fieldsAssign({ runId: RunId, sequence: PositiveInt })),
)
export type RunEvent = typeof RunEvent.Type
export const NodeVisualState = Schema.Literals(['idle', 'running', 'succeeded', 'failed', 'waiting'])
export type NodeVisualState = typeof NodeVisualState.Type
export const Position = Schema.Struct({ x: Schema.Number, y: Schema.Number })
export type Position = typeof Position.Type
export const Size = Schema.Struct({ width: Schema.Number, height: Schema.Number })
export type Size = typeof Size.Type
export const NodeShape = Schema.Struct({
  id: NodeId,
  nodeId: NodeId,
  type: Schema.Literal('node'),
  label: Schema.String,
  kind: Schema.Literals(['task', 'checkpoint']),
  position: Position,
  size: Size,
  state: NodeVisualState,
})
export const EdgeShape = Schema.Struct({
  id: EdgeId,
  type: Schema.Literal('edge'),
  source: NodeId,
  target: NodeId,
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
export const CreateRun = Schema.StructWithRest(Schema.Struct({ workflowId: WorkflowId, version: WorkflowVersion }), [
  // Additional workflow input must not reprocess the routing fields' domain codecs.
  // This is intentionally unknown until workflow.prepare validates its own domain input, not a persisted JSON object.
  Schema.Record(
    Schema.String.check(Schema.makeFilter((key) => key !== 'workflowId' && key !== 'version')),
    Schema.Unknown,
  ),
])
export type CreateRun = typeof CreateRun.Type
export const WorkflowsResponse = Schema.Struct({ workflows: Schema.Array(WorkflowSummary) })
export const RunsResponse = Schema.Struct({ runs: Schema.Array(Run) })
export const ApiErrorResponse = Schema.Struct({ error: Schema.String, message: Schema.String })
