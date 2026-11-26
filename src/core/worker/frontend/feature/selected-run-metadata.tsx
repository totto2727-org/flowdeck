import { GitBranch } from 'lucide-react'
import type { ReactElement } from 'react'

import { shortId } from './presentation.ts'
import type { RunDetail } from './view-model.ts'

const workflowIconSize = 14

const workflow = (id: string): ReactElement => (
  <span>
    <GitBranch size={workflowIconSize} />
    {id}
  </span>
)

const graph = (id: string): ReactElement => (
  <span title={id}>
    Graph <code>{shortId(id)}</code>
  </span>
)

export const SelectedRunMetadata = ({
  graphId,
  revision,
  workflowId,
}: Readonly<{
  graphId: RunDetail['run']['graphId']
  revision: RunDetail['state']['revision']
  workflowId: RunDetail['run']['workflowId']
}>): ReactElement => {
  return (
    <div className='flex flex-wrap gap-4 px-[23px] pb-5 text-[10px] text-[#7a8b80] dark:text-muted-foreground [&>span]:inline-flex [&>span]:items-center [&>span]:gap-1.25'>
      {workflow(workflowId)}
      <span>Revision {revision}</span>
      {graph(graphId)}
    </div>
  )
}
