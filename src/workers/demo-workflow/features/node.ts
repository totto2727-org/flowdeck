import { Effect, Schema } from 'effect'

import { TaskExecution, taskResult, type Definition, type Task } from '@/features/workflow/driver'

export const DemoContext = Schema.Struct({ prepared: Schema.String, result: Schema.String })
export type DemoContext = typeof DemoContext.Type
export const initialDemoContext: DemoContext = { prepared: '', result: '' }
const outcomes = taskResult<DemoContext>()
export const approvalTask: Task<DemoContext> = {
  execute: (context) =>
    Effect.gen(function* () {
      const control = yield* TaskExecution
      return control.operation === 'resume'
        ? outcomes.Done({ context, payload: { approved: true } })
        : outcomes.Wait({ context })
    }),
}
export const publishTask: Task<DemoContext> = {
  execute: (context) => {
    const result = `published:${context.prepared}`
    return Effect.succeed(outcomes.Done({ context: { ...context, result }, payload: { output: result } }))
  },
}
export type DemoDefinition = Definition<DemoContext>
