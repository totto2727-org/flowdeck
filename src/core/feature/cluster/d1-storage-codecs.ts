import type { Machine } from '@typeonce/effect-machine'
import { Schema } from 'effect'
import { Snowflake } from 'effect/cluster'

// Validate the public persistence envelope, not machine-specific state semantics.
const Snapshot = Schema.Struct({
  _tag: Schema.Literal('MachineSnapshot'),
  version: Schema.Literal(2),
  active: Schema.Array(Schema.Struct({ path: Schema.String, value: Schema.optionalKey(Schema.Json) })),
  completed: Schema.optionalKey(
    Schema.Array(Schema.Struct({ path: Schema.String, output: Schema.optionalKey(Schema.Json) })),
  ),
  history: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        mode: Schema.Literals(['shallow', 'deep']),
        active: Schema.Array(Schema.String),
        values: Schema.Record(Schema.String, Schema.Json),
      }),
    ),
  ),
}) satisfies Schema.Codec<Machine.Machine.EncodedSnapshot>

const SnapshotJson = Schema.fromJsonString(Snapshot)
export const encodeSnapshot = Schema.encodeEffect(SnapshotJson)
export const decodeSnapshot = Schema.decodeUnknownEffect(SnapshotJson)
export const encodeRequestId = Schema.encodeEffect(Snowflake.SnowflakeFromString)
export const decodeRequestId = Schema.decodeUnknownEffect(Snowflake.SnowflakeFromString)
