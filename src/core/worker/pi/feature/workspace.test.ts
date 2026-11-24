import { createPiTools } from '@cloudflare/computer/tools/pi-ai'
import { Array, Option, Predicate } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import { missingGreeting, replayWorkspaceTool, workspaceFixture } from './workspace.fixture.ts'
import { CONTAINER_BACKEND, createWorkspaceTools, WORKER_SHELL_BACKEND } from './workspace.ts'

const workspaceCalls = [
  { arguments: { command: 'echo hello' }, fail: false, name: 'exec' },
  { arguments: { command: 'echo hello' }, fail: true, name: 'exec' },
  { arguments: { path: '/workspace' }, fail: false, name: 'ls' },
  { arguments: { path: '/workspace/hello.txt' }, fail: false, name: 'read' },
]
const cases = Array.flatMap([CONTAINER_BACKEND, WORKER_SHELL_BACKEND], (backendId) =>
  Array.map(workspaceCalls, (call) => ({ ...call, backendId })),
)

describe('pi workspace tool replay', () => {
  test.each(cases)(
    'commits Computer $name output from $backendId to the durable model transcript (failure=$fail)',
    async (call) => {
      const { callId, expected, resultMessages, task } = await replayWorkspaceTool(call)
      expect(task).toMatchObject({ state: { outcome: { status: 'completed' } } })
      expect(resultMessages).toHaveLength(1)
      expect(Array.getUnsafe(resultMessages, 0)).toMatchObject({
        content: expected.content,
        isError: expected.isError,
        role: 'toolResult',
        toolCallId: callId,
        toolName: call.name,
      })
      expect(expected.content).not.toStrictEqual([])
      expect(missingGreeting(call, expected)).toBe(false)
    },
  )
})

type Tool = ReturnType<typeof createWorkspaceTools>[number]
type Declaration = Pick<Tool, 'constrainedSampling' | 'description' | 'name' | 'parameters'>

const declaration = (tool: Tool): Declaration => ({
  ...(Predicate.isTruthy(tool.constrainedSampling) ? { constrainedSampling: tool.constrainedSampling } : {}),
  description: tool.description,
  name: tool.name,
  parameters: tool.parameters,
})

describe('pi workspace tool declarations', () => {
  test('preserves the official declarations and schema enforcement metadata', () => {
    const workspace = workspaceFixture()
    const { tools } = createPiTools({ exec: { [CONTAINER_BACKEND]: {} }, workspace })
    const actual = Array.map(createWorkspaceTools(workspace), declaration)
    expect(actual).toStrictEqual(tools)
  })

  test('keeps non-idempotent edit and shell commands unsafe to replay', () => {
    const tools = createWorkspaceTools(workspaceFixture())
    expect(Array.map(tools, ({ name, replay }) => ({ name, replay }))).toStrictEqual([
      { name: 'read', replay: 'safe' },
      { name: 'ls', replay: 'safe' },
      { name: 'find', replay: 'safe' },
      { name: 'grep', replay: 'safe' },
      { name: 'write', replay: 'safe' },
      { name: 'edit', replay: 'unsafe' },
      { name: 'delete', replay: 'safe' },
      { name: 'exec', replay: 'unsafe' },
    ])
  })

  test('offers only the Container shell without JavaScript module arguments', () => {
    const found = Array.findFirst(createWorkspaceTools(workspaceFixture()), (tool) => tool.name === 'exec')
    const exec = Option.getOrThrow(found)
    expect(exec.description).toContain('Runs shell commands.')
    expect(exec.parameters).toHaveProperty('properties.command')
    expect(exec.parameters).not.toHaveProperty('properties.backend')
    expect(exec.parameters).not.toHaveProperty('properties.input')
  })
})
