import type { Machine } from '@typeonce/effect-machine'
import { Schema } from 'effect'
import { Snowflake } from 'effect/cluster'

const snapshotVersion = 2
const ActiveState = Schema.Struct({ path: Schema.String, value: Schema.optionalKey(Schema.Json) })
const CompletedState = Schema.Struct({ output: Schema.optionalKey(Schema.Json), path: Schema.String })
const HistoryState = Schema.Struct({
  active: Schema.Array(Schema.String),
  mode: Schema.Literals(['shallow', 'deep']),
  values: Schema.Record(Schema.String, Schema.Json),
})
const History = Schema.Record(Schema.String, HistoryState)

// Validate the public persistence envelope before restoring machine state.
const Snapshot = Schema.TaggedStruct('MachineSnapshot', {
  active: Schema.Array(ActiveState),
  completed: Schema.optionalKey(Schema.Array(CompletedState)),
  history: Schema.optionalKey(History),
  version: Schema.Literal(snapshotVersion),
}) satisfies Schema.Codec<Machine.Machine.EncodedSnapshot>

const SnapshotJson = Schema.fromJsonString(Snapshot)
export const encodeSnapshot = Schema.encodeEffect(SnapshotJson)
export const decodeSnapshot = Schema.decodeEffect(SnapshotJson)
export const encodeRequestId = Schema.encodeEffect(Snowflake.SnowflakeFromString)
export const decodeRequestId = Schema.decodeEffect(Snowflake.SnowflakeFromString)
