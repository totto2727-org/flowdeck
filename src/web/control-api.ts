import { Context, Data, Effect, Schema } from 'effect'
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http'

import { CreateRun, RunDetail, RunsResponse, WorkflowsResponse } from '../domain/model'

export class ControlError extends Data.TaggedError('ControlError')<{
  readonly message: string
}> {}

/** The only data capability exposed to Effront. Transport is supplied by the Worker. */
export class ControlApi extends Context.Service<
  ControlApi,
  {
    readonly workflows: Effect.Effect<typeof WorkflowsResponse.Type, ControlError>
    readonly runs: Effect.Effect<typeof RunsResponse.Type, ControlError>
    readonly detail: (runId: string) => Effect.Effect<RunDetail, ControlError>
    readonly start: (input: CreateRun) => Effect.Effect<RunDetail, ControlError>
    readonly resume: (runId: string) => Effect.Effect<RunDetail, ControlError>
  }
>()('flowdeck/web/ControlApi') {}

export const makeControlApi = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient
  const request = <A>(schema: Schema.Codec<A, unknown>, outgoing: HttpClientRequest.HttpClientRequest) =>
    client.execute(outgoing).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
      Effect.mapError(
        () =>
          new ControlError({ message: 'The control plane could not complete this request. Refresh and try again.' }),
      ),
    )
  const url = (path: string) => `https://control.internal/api${path}`
  return ControlApi.of({
    workflows: request(WorkflowsResponse, HttpClientRequest.get(url('/workflows'))),
    runs: request(RunsResponse, HttpClientRequest.get(url('/runs'))),
    detail: (runId) => request(RunDetail, HttpClientRequest.get(url(`/runs/${encodeURIComponent(runId)}`))),
    start: (input) =>
      HttpClientRequest.post(url('/runs')).pipe(
        HttpClientRequest.bodyJson(input),
        Effect.flatMap((outgoing) => request(RunDetail, outgoing)),
        Effect.mapError(() => new ControlError({ message: 'The run could not be started. Refresh and try again.' })),
      ),
    resume: (runId) => request(RunDetail, HttpClientRequest.post(url(`/runs/${encodeURIComponent(runId)}/resume`))),
  })
})
