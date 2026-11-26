import { createPiTools } from '@cloudflare/computer/tools/pi-ai'
import type { CreatePiToolsOptions } from '@cloudflare/computer/tools/pi-ai'
import { createModels } from '@earendil-works/pi-ai'
import type { ToolCall } from '@earendil-works/pi-ai'
import { AssistantEntry, createRegistry, Harness, MemoryStorage, ToolTask } from '@earendil-works/pi-durable'
import type { SettledTask, TaskId, ToolTaskResult } from '@earendil-works/pi-durable'
import { Array, Function, Option } from 'effect'
import { vi } from 'vite-plus/test'

import { CONTAINER_BACKEND, createWorkspaceTools } from './workspace.ts'

type Workspace = CreatePiToolsOptions['workspace']
type Files = Workspace['fs']
type Shell = NonNullable<Workspace['runtime']>
type Root = Awaited<ReturnType<Harness['root']>>
// oxlint-disable-next-line eslint/no-magic-numbers -- The first parameter is the package's context contract.
type HarnessContext = Parameters<Harness['close']>[0]
type OfficialExecute = ReturnType<typeof createPiTools>['execute']
type ComputerResult = Awaited<ReturnType<OfficialExecute>>

export type WorkspaceCase = Readonly<{
  arguments: { command: string } | { path: string }
  backendId: string
  fail: boolean
  name: string
}>

// The workspace feeds per-call data to Computer and Pi. This fixture owns no live Container.
const readHello = async (): ReturnType<Files['readFile']> => {
  const origin = new Response('hello')
  const blob = await origin.blob()
  return blob.stream()
}
const files = (): Files => ({
  find: vi.fn<Files['find']>().mockResolvedValue([]),
  grep: vi.fn<Files['grep']>().mockResolvedValue([]),
  mkdir: vi.fn<Files['mkdir']>().mockResolvedValue(),
  readFile: vi.fn<Files['readFile']>().mockImplementation(readHello),
  readdir: vi.fn<Files['readdir']>().mockResolvedValue([]),
  rm: vi.fn<Files['rm']>().mockResolvedValue(),
  stat: vi.fn<Files['stat']>().mockResolvedValue({
    isDirectory: false,
    isFile: true,
    mode: 0o10_0644,
    mtime: 0,
    size: 5,
  }),
  writeFile: vi.fn<Files['writeFile']>().mockResolvedValue(),
})

const response = { exitCode: 0, stderr: '', stdout: 'hello' }
const openWorkspace = (backendId: string, unavailable: boolean): Workspace => {
  const result = vi.fn<Awaited<ReturnType<Shell['exec']>>['result']>().mockResolvedValue(response)
  const exec = vi.fn<Shell['exec']>().mockResolvedValue({ result })
  if (unavailable) {
    // oxlint-disable-next-line rules/require-tagged-error -- The fixture reproduces a native rejection from the Container binding.
    exec.mockRejectedValue(new Error('container unavailable'))
  }
  return {
    fs: files(),
    runtime: {
      backends: () => [{ callable: false, description: 'Runs shell commands.', id: backendId, protocol: 'command' }],
      exec,
    },
  }
}

export const workspaceFixture = (): Workspace => openWorkspace(CONTAINER_BACKEND, false)

const context: HarnessContext = {
  abortSignal: undefined,
  toString: () => '[workspace regression]',
  value: Function.constUndefined,
}
const tokenUsage = { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 }
const usage = { ...tokenUsage, cost: { ...tokenUsage, total: 0 }, totalTokens: 0 }
const callId = 'workspace-call'

const invokeTool = async (root: Root, toolCall: ToolCall): Promise<TaskId<ToolTaskResult>> =>
  root.commit(async (transaction) => {
    const assistant = await transaction.appendEntry(AssistantEntry, root.id, {
      model: [
        {
          api: 'openai-completions',
          content: [toolCall],
          model: 'test',
          provider: 'test',
          role: 'assistant',
          stopReason: 'toolUse',
          timestamp: 0,
          usage,
        },
      ],
    })
    return transaction.createTask(
      ToolTask,
      { assistant: assistant.id, callId: toolCall.id, kind: 'model' },
      { ownership: { kind: 'conversation' } },
    )
  }, context)

type WorkspaceOutcome = Readonly<{
  callId: string
  expected: ComputerResult
  resultMessages: Readonly<unknown[]>
  task: SettledTask<ToolTaskResult>
}>

const runConversation = async (
  harness: Harness,
  execute: OfficialExecute,
  call: WorkspaceCase,
): Promise<WorkspaceOutcome> => {
  const root = await harness.root(context)
  const toolCall: ToolCall = { arguments: call.arguments, id: callId, name: call.name, type: 'toolCall' }
  const expected = await execute(toolCall)
  const taskId = await invokeTool(root, toolCall)
  const task = await harness.waitForTask(taskId, context)
  const view = await root.context(context)
  const resultMessages = Array.filter(view.messages, (message) => message.role === 'toolResult')
  return { callId, expected, resultMessages, task }
}

export const replayWorkspaceTool = async (call: WorkspaceCase): Promise<WorkspaceOutcome> => {
  const workspace = openWorkspace(call.backendId, call.fail)
  const registry = createRegistry()
  registry.install({ name: 'workspace', tools: createWorkspaceTools(workspace, call.backendId) })
  const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry }, context)
  try {
    const { execute } = createPiTools({ exec: { [call.backendId]: {} }, workspace })
    return await runConversation(harness, execute, call)
  } finally {
    await harness.close(context)
  }
}

const expectedGreetingBlocks = 1
const expectedTextFields = 2

export const missingGreeting = ({ fail, name }: WorkspaceCase, result: ComputerResult): boolean => {
  if (name !== 'exec' || fail) {
    return false
  }
  const first = Array.head(result.content)
  if (Option.isNone(first) || Array.length(result.content) !== expectedGreetingBlocks) {
    return true
  }
  return (
    first.value.type !== 'text' ||
    !first.value.text.includes('hello') ||
    Array.length(Object.keys(first.value)) !== expectedTextFields
  )
}
