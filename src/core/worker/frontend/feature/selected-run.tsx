import { Predicate } from 'effect'
import { useState } from 'react'
import type { ReactElement } from 'react'

import { NodeInspector, RunGraph } from './graph.tsx'
import { runRecoveryAction } from './presentation.ts'
import { RunRecovery } from './run-recovery.tsx'
import { RunTopologyLegend } from './run-topology-legend.tsx'
import { RunTrace } from './run-trace.tsx'
import { SelectedRunHeader } from './selected-run-header.tsx'
import { SelectedRunMetadata } from './selected-run-metadata.tsx'
import type { RunDetail } from './view-model.ts'

type SelectedRunProps = Readonly<{
  detail: RunDetail
  onResume: () => void
  pending: boolean
}>

// oxlint-disable-next-line eslint/func-style -- The shared React rule requires a declaration for named components.
export function SelectedRun({ detail, onResume, pending }: SelectedRunProps): ReactElement {
  const [node, setNode] = useState<RunDetail['shapes']['nodes'][number]['nodeId']>()
  const recoveryAction = runRecoveryAction(detail.run.status)
  const recovery = Predicate.isNotNullish(recoveryAction) && (
    <RunRecovery action={recoveryAction} onResume={onResume} pending={pending} version={detail.run.workflowVersion} />
  )
  const topology = (
    <section
      className='min-w-0 overflow-hidden rounded-[10px] border border-border bg-card'
      aria-labelledby='selected-run-heading'
    >
      <SelectedRunHeader run={detail.run} />
      <SelectedRunMetadata
        graphId={detail.run.graphId}
        revision={detail.state.revision}
        workflowId={detail.run.workflowId}
      />
      {recovery}
      <RunTopologyLegend />
      <RunGraph detail={detail} selectedNode={node} onSelect={setNode} />
      <NodeInspector detail={detail} nodeId={node} />
    </section>
  )
  return (
    <>
      {topology}
      <RunTrace detail={detail} node={node} />
    </>
  )
}
