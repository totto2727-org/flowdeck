import { Context, Data, Effect, Schema } from 'effect'
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http'

import type { RunId } from '@/core/feature/workflow/domain/identity'
import { CreateRun, RunDetail, RunsResponse, WorkflowsResponse } from '@/core/feature/workflow/domain/model'

const encodeCreateRun = Schema.encodeSync(Schema.toCodecJson(CreateRun))

export class ControlError extends Data.TaggedError('ControlError')<{
  readonly message: string
}> {}

const makeRequest = <A, E>(decodeResponse: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, E>) =>
  Effect.map(
    HttpClient.HttpClient,
    (client) => (outgoing: HttpClientRequest.HttpClientRequest) =>
      client.execute(outgoing).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(decodeResponse),
        Effect.mapError(
          () =>
            new ControlError({ message: 'The control plane could not complete this request. Refresh and try again.' }),
        ),
      ),
  )
const decodeWorkflowsResponse = HttpClientResponse.schemaBodyJson(Schema.toCodecJson(WorkflowsResponse))
const decodeRunsResponse = HttpClientResponse.schemaBodyJson(Schema.toCodecJson(RunsResponse))
const decodeRunDetail = HttpClientResponse.schemaBodyJson(Schema.toCodecJson(RunDetail))
const makeWorkflowsRequest = makeRequest(decodeWorkflowsResponse)
const makeRunsRequest = makeRequest(decodeRunsResponse)
const makeRunDetailRequest = makeRequest(decodeRunDetail)

/** The only data capability exposed to Effront. Transport is supplied by the Worker. */
export class ControlApi extends Context.Service<
  ControlApi,
  {
    readonly workflows: Effect.Effect<typeof WorkflowsResponse.Type, ControlError>
    readonly runs: Effect.Effect<typeof RunsResponse.Type, ControlError>
    readonly detail: (runId: RunId) => Effect.Effect<RunDetail, ControlError>
    readonly start: (input: CreateRun) => Effect.Effect<RunDetail, ControlError>
    readonly resume: (runId: RunId) => Effect.Effect<RunDetail, ControlError>
  }
>()('flowdeck/web/ControlApi') {}

export const makeControlApi = Effect.gen(function* () {
  const requestWorkflows = yield* makeWorkflowsRequest
  const requestRuns = yield* makeRunsRequest
  const requestRunDetail = yield* makeRunDetailRequest
  const url = (path: string) => `https://control.internal/api${path}`
  return ControlApi.of({
    workflows: requestWorkflows(HttpClientRequest.get(url('/workflows'))),
    runs: requestRuns(HttpClientRequest.get(url('/runs'))),
    detail: (runId) => requestRunDetail(HttpClientRequest.get(url(`/runs/${encodeURIComponent(runId)}`))),
    start: (input) =>
      HttpClientRequest.post(url('/runs')).pipe(
        HttpClientRequest.bodyJson(encodeCreateRun(input)),
        Effect.flatMap(requestRunDetail),
        Effect.mapError(() => new ControlError({ message: 'The run could not be started. Refresh and try again.' })),
      ),
    resume: (runId) => requestRunDetail(HttpClientRequest.post(url(`/runs/${encodeURIComponent(runId)}/resume`))),
  })
})
