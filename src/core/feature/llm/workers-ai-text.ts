import { AI } from 'alchemy/Cloudflare/Workers'
import type { RuntimeContext } from 'alchemy/RuntimeContext'
import { Context, Effect, Layer, Schema } from 'effect'

/** Explicitly supported native text models share prompt input and nonstream text output. */
export const WorkersAiTextModel = Schema.Literals([
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/meta/llama-3.1-8b-instruct-fp8',
])
export type WorkersAiTextModel = typeof WorkersAiTextModel.Type

export const workersAiTextModel = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'

// Keep only prompt inputs accepted by both native catalog contracts.
type NativeInput = AiModels[typeof workersAiTextModel]['inputs'] &
  AiModels['@cf/meta/llama-3.1-8b-instruct-fp8']['inputs']
export type WorkersAiTextInput = Omit<Extract<NativeInput, { prompt: string }>, 'stream'>

const TextOutput = Schema.Union([Schema.String, Schema.Struct({ response: Schema.String })])
const decodeTextOutput = Schema.decodeUnknownEffect(TextOutput)

/** Acquire this once at the runtime root, with Alchemy's official AIBinding Layer. */
export const makeWorkersAiText = Effect.gen(function* () {
  const client = yield* AI()
  const context = yield* Effect.context<RuntimeContext>()

  const generate = Effect.fn('WorkersAiText.generate')(function* (
    input: WorkersAiTextInput,
    model: WorkersAiTextModel = workersAiTextModel,
  ) {
    // Alchemy's native run method declares a runtime-context requirement. Capture it
    // at construction so a Machine invoke cannot select a different caller runtime.
    // This is only SDK context closure, not a second binding or inference executor.
    const output = yield* client.run(model, { ...input, stream: false }).pipe(Effect.provideContext(context))
    const text = yield* decodeTextOutput(output)
    return typeof text === 'string' ? text : text.response
  })

  return { generate }
})

/** Ordinary Machine invokes can yield this service and call generate without native runtime requirements. */
export class WorkersAiText extends Context.Service<WorkersAiText, Effect.Success<typeof makeWorkersAiText>>()(
  'flowdeck/WorkersAiText',
) {}

export const WorkersAiTextLive = Layer.effect(WorkersAiText, makeWorkersAiText)
