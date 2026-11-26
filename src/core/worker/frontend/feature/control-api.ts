import { Context, Effect, Schema } from 'effect'
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http'

import type { RunId } from '@/core/feature/workflow/domain/identity'
import { CreateRun, RunDetail, RunsResponse, WorkflowsResponse } from '@/core/feature/workflow/domain/model'

import { ControlError } from './control-error.ts'

export { ControlError } from './control-error.ts'

const encodeCreateRun = Schema.encodeEffect(Schema.toCodecJson(CreateRun))

type DecodeResponse<A, E> = (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, E>
type RequestResponse<A> = (outgoing: HttpClientRequest.HttpClientRequest) => Effect.Effect<A, ControlError>

const invalidResponse = (): ControlError =>
  new ControlError({ message: 'The control plane could not complete this request. Refresh and try again.' })

const startFailed = (): ControlError =>
  new ControlError({ message: 'The run could not be started. Refresh and try again.' })

const makeRequest =
  <A, E>(client: HttpClient.HttpClient, decodeResponse: DecodeResponse<A, E>): RequestResponse<A> =>
  (outgoing) =>
    client
      .execute(outgoing)
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(decodeResponse),
        Effect.mapError(invalidResponse),
      )

const decodeWorkflowsResponse = HttpClientResponse.schemaBodyJson(Schema.toCodecJson(WorkflowsResponse))
const decodeRunsResponse = HttpClientResponse.schemaBodyJson(Schema.toCodecJson(RunsResponse))
const decodeRunDetail = HttpClientResponse.schemaBodyJson(Schema.toCodecJson(RunDetail))
const controlUrl = (path: string): string => `https://control.internal/api${path}`
const workflowsRequest = HttpClientRequest.get(controlUrl('/workflows'))
const runsRequest = HttpClientRequest.get(controlUrl('/runs'))
const startRunRequest = HttpClientRequest.post(controlUrl('/runs'))

const runPath = (runId: RunId): string => `/runs/${encodeURIComponent(runId)}`

/** The only data capability exposed to Effront. Transport is supplied by the Worker. */
export class ControlApi extends Context.Service<
  ControlApi,
  Readonly<{
    workflows: Effect.Effect<typeof WorkflowsResponse.Type, ControlError>
    runs: Effect.Effect<typeof RunsResponse.Type, ControlError>
    detail: (runId: RunId) => Effect.Effect<RunDetail, ControlError>
    start: (input: CreateRun) => Effect.Effect<RunDetail, ControlError>
    resume: (runId: RunId) => Effect.Effect<RunDetail, ControlError>
  }>
>()('flowdeck/web/ControlApi') {}

export const makeControlApi = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient
  const requestWorkflows = makeRequest(client, decodeWorkflowsResponse)
  const requestRuns = makeRequest(client, decodeRunsResponse)
  const requestRunDetail = makeRequest(client, decodeRunDetail)
  return ControlApi.of({
    detail: (runId) => {
      const url = controlUrl(runPath(runId))
      return requestRunDetail(HttpClientRequest.get(url))
    },
    resume: (runId) => {
      const url = controlUrl(`${runPath(runId)}/resume`)
      return requestRunDetail(HttpClientRequest.post(url))
    },
    runs: requestRuns(runsRequest),
    start: (input) =>
      Effect.gen(function* () {
        const payload = yield* encodeCreateRun(input)
        const request = yield* startRunRequest.pipe(HttpClientRequest.bodyJson(payload))
        return yield* requestRunDetail(request)
      }).pipe(Effect.mapError(startFailed)),
    workflows: requestWorkflows(workflowsRequest),
  })
})
