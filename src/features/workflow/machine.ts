import { Machine as Native } from '@typeonce/effect-machine'
import { Array, Effect, Option, Schema } from 'effect'

import { InvalidSnapshot } from '@/features/workflow/domain/errors'
import { GraphDefinition, JsonObject } from '@/features/workflow/domain/model'

const DoneEvent = Schema.TaggedStruct('Done', { context: JsonObject })
export const TaskEvents = Native.eventsFromSchemas(DoneEvent)
const decodeGraph = Schema.decodeUnknownSync(GraphDefinition)
const decodeObject = Schema.decodeUnknownSync(JsonObject)
const nodeMetadata = Schema.Struct({ title: Schema.String, description: Schema.Literals(['task', 'checkpoint']) })
const decodeNodeMetadata = Schema.decodeUnknownSync(nodeMetadata)

export interface MachinePosition {
  readonly value: string
  readonly encoded: JsonObject
  readonly completed: boolean
}
export interface Machine<C> {
  readonly graph: GraphDefinition
  readonly initial: Effect.Effect<MachinePosition, InvalidSnapshot>
  readonly next: (encoded: JsonObject, context: C) => Effect.Effect<MachinePosition, InvalidSnapshot>
  readonly validate: (encoded: JsonObject) => Effect.Effect<MachinePosition, InvalidSnapshot>
}

/** A data-only planner adapter. The native library owns transition selection,
 * topology, and snapshot codecs. D1 owns task intents, not a live MachineRef. */
export const makeMachine = <
  States extends Native.Machine.StateSchemas,
  Final extends Native.Machine.StateIdentifier<States>,
  Output,
>(options: {
  readonly graphId: string
  readonly native: Native.Machine<
    States,
    readonly [typeof DoneEvent],
    typeof Schema.Void,
    never,
    never,
    never,
    never,
    never,
    Final,
    Output
  > &
    Native.Machine.EnsureOutputImplementations<States, never> &
    Native.Machine.EnsureHistoryImplementations<States, never>
}) => {
  const native: Native.Machine<
    States,
    readonly [typeof DoneEvent],
    typeof Schema.Void,
    never,
    never,
    never,
    never,
    never,
    Final,
    Output
  > = options.native
  const allNodes = Native.stateNodes(native)
  if (
    Native.activityDefinitions(native).length !== 0 ||
    Array.some(allNodes, (node) => node.path !== '' && node.type !== 'atomic' && node.type !== 'final')
  ) {
    throw new InvalidSnapshot({ message: 'The durable task adapter supports only data-only flat machines' })
  }
  const transitions = Native.transitionDefinitions(native)
  if (
    Array.some(
      transitions,
      (edge) =>
        edge.trigger.type !== 'event' ||
        edge.trigger.event !== 'Done' ||
        Array.some(edge.branches, (branch) => branch.target === undefined),
    )
  ) {
    throw new InvalidSnapshot({ message: 'Task machines require Done transitions with explicit state targets' })
  }
  const pairs = Array.flatMap(transitions, (edge) =>
    Array.map(edge.branches, (branch) => `${edge.source}-${branch.target}`),
  )
  if (Array.dedupe(pairs).length !== pairs.length) {
    throw new InvalidSnapshot({ message: 'Task graph transitions must have unique source-target pairs' })
  }
  const nodes = Array.filter(allNodes, (node) => node.type === 'atomic' && node.path !== '')
  const paths = Array.map(nodes, (node) => node.path)
  const graph = decodeGraph({
    graphId: options.graphId,
    schemaVersion: 1,
    nodes: Array.map(nodes, (node) => {
      const meta = decodeNodeMetadata(node.annotations)
      return { nodeId: node.path, label: meta.title, kind: meta.description }
    }),
    edges: Array.flatMap(transitions, (edge) =>
      Array.flatMap(edge.branches, (branch) => {
        const target = branch.target
        if (target === undefined || !Array.contains(paths, target)) return []
        return [
          {
            edgeId: `${edge.source}-${target}`,
            source: edge.source,
            target,
            label:
              branch.type === 'branch'
                ? branch.title
                : edge.trigger.type === 'event'
                  ? String(edge.trigger.event)
                  : edge.trigger.type,
          },
        ]
      }),
    ),
  })
  const position = (state: Native.Machine.Snapshot<States>) =>
    Effect.gen(function* () {
      const configuration = Native.configuration(native, state)
      const leaves = Array.filter(configuration, (node) => node.type === 'atomic' || node.type === 'final')
      const leaf = Array.head(leaves)
      if (leaves.length !== 1 || Option.isNone(leaf))
        return yield* Effect.fail(new InvalidSnapshot({ message: 'A task machine requires one active leaf' }))
      const encoded = yield* Native.encodeSnapshot(native, state)
      return { value: leaf.value.path, encoded: decodeObject(encoded), completed: leaf.value.type === 'final' }
    }).pipe(Effect.mapError(() => new InvalidSnapshot({ message: 'Invalid native machine snapshot' })))
  return {
    graph,
    initial: Native.planInitial(options.native).pipe(
      Effect.flatMap((plan) =>
        plan.commands.length === 0
          ? position(plan.state)
          : Effect.fail(new InvalidSnapshot({ message: 'Native startup commands require a managed machine runtime' })),
      ),
      Effect.mapError(() => new InvalidSnapshot({ message: 'Invalid initial machine state' })),
    ),
    next: (encoded: JsonObject, context: JsonObject) =>
      Native.decodeSnapshot(native, encoded).pipe(
        Effect.flatMap((state) => Native.plan(options.native, state, TaskEvents.Done({ context }))),
        Effect.flatMap((plan) =>
          plan.commands.length === 0 && Array.some(plan.microsteps, (step) => step.transitions.length > 0)
            ? position(plan.next)
            : Effect.fail(
                new InvalidSnapshot({
                  message: 'Task completion requires a native transition without runtime commands',
                }),
              ),
        ),
        Effect.mapError(() => new InvalidSnapshot({ message: 'Invalid native machine transition' })),
      ),
    validate: (encoded: JsonObject) =>
      Native.decodeSnapshot(native, encoded).pipe(
        Effect.flatMap(position),
        Effect.mapError(() => new InvalidSnapshot({ message: 'Invalid native machine checkpoint' })),
      ),
  }
}
