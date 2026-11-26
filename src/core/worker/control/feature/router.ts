import type { RpcCallError, RpcDecodeError } from 'alchemy/Rpc'
import { Effect, Layer, Option, Record, Schema } from 'effect'
import { Headers, HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'
import type { HttpBody, HttpServerError } from 'effect/http'

import { ExternalError } from '@/core/feature/workflow/domain/errors'
import { RunId } from '@/core/feature/workflow/domain/identity'
import {
  ApiErrorResponse,
  CreateRun,
  RunDetail,
  RunsResponse,
  WorkflowsResponse,
} from '@/core/feature/workflow/domain/model'
import { RpcProblem } from '@/core/feature/workflow/rpc/problem'
import type { Rfc9457ProblemDetails } from '@/core/feature/workflow/rpc/problem'
import { Workflows } from '@/core/feature/workflow/services/workflows'
import { HttpStatus } from '@/share/feature/http/status'
import { operationFailureLogging } from '@/share/feature/operation-logging'

type WorkflowFailure = Effect.Error<ReturnType<Workflows['Service']['createRun']>>

type ApiFailure =
  | WorkflowFailure
  | HttpServerError.HttpServerError
  | HttpBody.HttpBodyError
  | RpcCallError
  | RpcDecodeError
const respondApiError = HttpServerResponse.schemaJson(Schema.toCodecJson(ApiErrorResponse))
const respondWorkflows = HttpServerResponse.schemaJson(Schema.toCodecJson(WorkflowsResponse))
const respondRuns = HttpServerResponse.schemaJson(Schema.toCodecJson(RunsResponse))
const respondRunDetail = HttpServerResponse.schemaJson(Schema.toCodecJson(RunDetail))
// oxlint-disable-next-line rules/prefer-non-unknown-decode -- Native route parameters may omit a run ID or contain an invalid string.
const decodeRunParams = Schema.decodeUnknownEffect(Schema.Struct({ runId: RunId }))
const createRunBody = HttpServerRequest.schemaBodyJson(Schema.toCodecJson(CreateRun), {
  onExcessProperty: 'error',
})
const errorResponse = (
  status: number,
  error: string,
  message: string,
): Effect.Effect<HttpServerResponse.HttpServerResponse, HttpBody.HttpBodyError> =>
  respondApiError({ error, message }, { status })

const problemErrorCode = {
  [RpcProblem.conflict.type]: 'Conflict',
  [RpcProblem.internal.type]: 'ExternalError',
  [RpcProblem.invalidOperation.type]: 'InvalidOperation',
  [RpcProblem.invalidRequest.type]: 'InvalidRequest',
  [RpcProblem.invalidSnapshot.type]: 'InvalidSnapshot',
  [RpcProblem.notFound.type]: 'NotFound',
  [RpcProblem.service.type]: 'ExternalError',
  [RpcProblem.storage.type]: 'ExternalError',
} satisfies globalThis.Record<Rfc9457ProblemDetails['type'], string>

const unavailableWorkflow = (cause: RpcCallError | RpcDecodeError): Effect.Effect<never, ExternalError> =>
  Effect.fail(new ExternalError({ cause, kind: 'service', operation: 'call workflow worker' }))

const conflict = (): Effect.Effect<HttpServerResponse.HttpServerResponse, HttpBody.HttpBodyError> =>
  errorResponse(HttpStatus.conflict, 'Conflict', 'Run changed concurrently or a delivery ID was reused')

const ApiErrors = HttpRouter.middleware<{ handles: ApiFailure }>()((handler) =>
  handler.pipe(
    operationFailureLogging,
    // The RPC client's declared service shape does not include its transport failures.
    Effect.catchTags({ RpcCallError: unavailableWorkflow, RpcDecodeError: unavailableWorkflow }),
    Effect.catchTags({
      Conflict: conflict,
      ExternalError: (error) =>
        error.kind === 'storage'
          ? errorResponse(HttpStatus.internalServerError, 'ExternalError', 'Persistence operation failed')
          : errorResponse(
              HttpStatus.badGateway,
              'ExternalError',
              'Workflow worker is unavailable. The run remains persisted',
            ),
      HttpBodyError: () =>
        errorResponse(HttpStatus.internalServerError, 'EncodingError', 'Response could not be encoded'),
      HttpServerError: () => errorResponse(HttpStatus.badRequest, 'InvalidRequest', 'Request body could not be read'),
      InvalidOperation: (error) => errorResponse(HttpStatus.conflict, 'InvalidOperation', error.message),
      InvalidSnapshot: () =>
        errorResponse(HttpStatus.conflict, 'InvalidSnapshot', 'Persisted workflow state is invalid'),
      NotFound: () => errorResponse(HttpStatus.notFound, 'NotFound', 'Run or graph not found'),
      PlatformError: () =>
        errorResponse(HttpStatus.internalServerError, 'PlatformError', 'Run identity could not be generated'),
      RemoteWorkerError: ({ cause }) => {
        const code = Record.get(problemErrorCode, cause.type)
        return errorResponse(
          cause.status,
          Option.getOrElse(code, () => 'ExternalError'),
          cause.detail,
        )
      },
      SchemaError: () =>
        errorResponse(HttpStatus.badRequest, 'InvalidRequest', 'Request does not match the API schema'),
      StorageConflict: conflict,
    }),
  ),
)

// Reject browser mutations before body decoding, including text/plain no-cors submissions.
const ServerMutations = HttpRouter.middleware((handler) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (request.method === 'POST' && Headers.has(request.headers, 'origin')) {
      return yield* errorResponse(
        HttpStatus.forbidden,
        'Forbidden',
        'Browser-originated control mutations are not allowed',
      )
    }
    return yield* handler
  }),
)

const runId = HttpRouter.params.pipe(
  Effect.flatMap(decodeRunParams),
  Effect.map((params) => params.runId),
)

const apiMiddleware = ApiErrors.combine(ServerMutations).layer

const createRun = Effect.gen(function* () {
  const input = yield* createRunBody
  const workflows = yield* Workflows
  const detail = yield* workflows.createRun(input)
  return yield* respondRunDetail(detail, { status: HttpStatus.created })
})

const getRun = Effect.gen(function* () {
  const workflows = yield* Workflows
  const id = yield* runId
  const detail = yield* workflows.getRunDetail(id)
  return yield* respondRunDetail(detail)
})

const resumeRun = Effect.gen(function* () {
  const workflows = yield* Workflows
  const id = yield* runId
  const detail = yield* workflows.resumeRun(id)
  return yield* respondRunDetail(detail)
})

// oxlint-disable-next-line react-hooks/rules-of-hooks -- Effect HttpRouter.use registers HTTP routes.
export const ApiRoutes = HttpRouter.use((router) => {
  const routes = [
    HttpRouter.route(
      'GET',
      '/api/workflows',
      Workflows.pipe(
        Effect.flatMap((workflows) => workflows.listWorkflows()),
        Effect.flatMap(respondWorkflows),
      ),
    ),
    HttpRouter.route(
      'GET',
      '/api/runs',
      Workflows.pipe(
        Effect.flatMap((workflows) => workflows.listRuns()),
        Effect.flatMap(respondRuns),
      ),
    ),
    HttpRouter.route('POST', '/api/runs', createRun),
    HttpRouter.route('GET', '/api/runs/:runId', getRun),
    HttpRouter.route('POST', '/api/runs/:runId/resume', resumeRun),
  ]
  return router.addAll(routes)
}).pipe(Layer.provide(apiMiddleware))
