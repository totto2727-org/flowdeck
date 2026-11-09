import { Effect } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { TaskExecution } from '@/features/workflow/driver'

import { approvalTask, initialDemoContext, publishTask } from './node'

const control: typeof TaskExecution.Service = {
  runId: 'run_00000000-0000-4000-8000-000000000001',
  executionId: 'execution_00000000-0000-4000-8000-000000000001',
  operation: 'start',
  checkpoint: () => Effect.void,
}

describe('demo tasks', () => {
  it('waits for explicit approval instead of completing automatically', async () => {
    expect(
      await Effect.runPromise(
        approvalTask.execute(initialDemoContext).pipe(Effect.provideService(TaskExecution, control)),
      ),
    ).toMatchObject({ _tag: 'Wait' })
    expect(
      await Effect.runPromise(
        approvalTask
          .execute(initialDemoContext)
          .pipe(Effect.provideService(TaskExecution, { ...control, operation: 'resume' })),
      ),
    ).toEqual({
      _tag: 'Done',
      context: initialDemoContext,
      payload: { approved: true },
    })
  })
  it('publishes the selected version data and returns JSON event output', async () => {
    expect(
      await Effect.runPromise(
        publishTask
          .execute({ prepared: 'draft:v2:reviewed', result: '' })
          .pipe(Effect.provideService(TaskExecution, control)),
      ),
    ).toEqual({
      _tag: 'Done',
      context: { prepared: 'draft:v2:reviewed', result: 'published:draft:v2:reviewed' },
      payload: { output: 'published:draft:v2:reviewed' },
    })
  })
})
