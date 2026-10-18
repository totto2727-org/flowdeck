import { createPiTools, type CreatePiToolsOptions } from '@cloudflare/computer/tools/pi-ai'
import { createModels } from '@earendil-works/pi-ai'
import { AssistantEntry, createRegistry, Harness, MemoryStorage, ToolTask } from '@earendil-works/pi-durable'
import { Array } from 'effect'
import { describe, expect, it, vi } from 'vite-plus/test'

import { CONTAINER_BACKEND, createWorkspaceTools } from './workspace'

// Synthetic storage/runtime boundary: these checks do not start a Container or test persistence.
const fixture = () =>
  ({
    fs: {
      stat: vi.fn(async () => ({
        size: 5,
        mtime: 0,
        mode: 0o100644,
        isFile: true,
        isDirectory: false,
      })),
      readFile: vi.fn(
        async () =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('hello'))
              controller.close()
            },
          }),
      ),
      writeFile: vi.fn(async () => {}),
      mkdir: vi.fn(async () => {}),
      rm: vi.fn(async () => {}),
      find: vi.fn(async () => []),
      grep: vi.fn(async () => []),
      readdir: vi.fn(async () => []),
    },
    runtime: {
      backends: () => [
        { id: CONTAINER_BACKEND, protocol: 'command' as const, callable: false, description: 'Runs shell commands.' },
      ],
      exec: vi.fn(async () => ({
        result: async () => ({ exitCode: 0, stdout: 'hello', stderr: '' }),
      })),
    },
  }) satisfies CreatePiToolsOptions['workspace']

describe('Pi workspace tools', () => {
  it.each([
    { name: 'exec', arguments: { command: 'echo hello' }, fail: false },
    { name: 'exec', arguments: { command: 'echo hello' }, fail: true },
    { name: 'ls', arguments: { path: '/workspace' }, fail: false },
    { name: 'read', arguments: { path: '/workspace/hello.txt' }, fail: false },
  ])('commits Computer $name output to the durable model transcript (failure=$fail)', async (call) => {
    const workspace = fixture()
    if (call.fail) workspace.runtime.exec.mockRejectedValue(new Error('container unavailable'))
    const context: Parameters<Harness['close']>[0] = {
      abortSignal: undefined,
      value: () => undefined,
      toString: () => '[workspace regression]',
    }
    const registry = createRegistry()
    registry.install({ name: 'workspace', tools: createWorkspaceTools(workspace) })
    const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry }, context)
    try {
      const root = await harness.root(context)
      const toolCall = { type: 'toolCall' as const, id: 'workspace-call', name: call.name, arguments: call.arguments }
      const { execute } = createPiTools({ workspace, exec: { [CONTAINER_BACKEND]: {} } })
      const expected = await execute(toolCall)
      const task = await root.commit(async (tx) => {
        const assistant = await tx.appendEntry(AssistantEntry, root.id, {
          model: [
            {
              role: 'assistant',
              content: [toolCall],
              api: 'openai-completions',
              provider: 'test',
              model: 'test',
              stopReason: 'toolUse',
              timestamp: 0,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
            },
          ],
        })
        return tx.createTask(
          ToolTask,
          { kind: 'model', assistant: assistant.id, callId: toolCall.id },
          {
            ownership: { kind: 'conversation' },
          },
        )
      }, context)
      expect(await harness.waitForTask(task, context)).toMatchObject({ state: { outcome: { status: 'completed' } } })
      const view = await root.context(context)
      expect(Array.filter(view.messages, (message) => message.role === 'toolResult')).toEqual([
        expect.objectContaining({
          role: 'toolResult',
          toolCallId: toolCall.id,
          toolName: call.name,
          content: expected.content,
          isError: expected.isError,
        }),
      ])
      expect(expected.content).not.toEqual([])
      if (call.name === 'exec' && !call.fail)
        expect(expected.content).toEqual([{ type: 'text', text: expect.stringContaining('hello') }])
    } finally {
      await harness.close(context)
    }
  })

  it('preserves the official declarations and schema enforcement metadata', () => {
    const workspace = fixture()
    const { tools } = createPiTools({
      workspace,
      shell: { defaultBackend: CONTAINER_BACKEND, backends: { [CONTAINER_BACKEND]: {} } },
    })
    expect(
      Array.map(createWorkspaceTools(workspace), (tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        ...(tool.constrainedSampling ? { constrainedSampling: tool.constrainedSampling } : {}),
      })),
    ).toEqual(tools)
  })

  it('keeps non-idempotent edit and shell commands unsafe to replay', () => {
    expect(Array.map(createWorkspaceTools(fixture()), ({ name, replay }) => ({ name, replay }))).toEqual([
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

  it('offers only the Container shell without JavaScript module arguments', () => {
    const exec = Array.findFirst(createWorkspaceTools(fixture()), (tool) => tool.name === 'exec')
    expect(exec).toMatchObject({
      _tag: 'Some',
      value: { description: expect.stringContaining('Runs shell commands.') },
    })
    if (exec._tag === 'Some') {
      expect(exec.value.parameters).toHaveProperty('properties.command')
      expect(exec.value.parameters).not.toHaveProperty('properties.backend')
      expect(exec.value.parameters).not.toHaveProperty('properties.input')
    }
  })
})
