import { Array, Predicate } from 'effect'
import { GitBranch } from 'lucide-react'
import type { ReactElement } from 'react'

import type { WorkflowSummary } from './view-model.ts'
import { LaunchForm } from './workflow-launch-form.tsx'
import type { LaunchControls } from './workflow-launch-form.tsx'

const launchDescription = (workflow: WorkflowSummary | undefined): ReactElement => (
  <div>
    <p className='mb-1.25 text-[10px] font-[650] tracking-[1.15px] text-[#78867f] uppercase dark:text-muted-foreground'>
      Registered workflow
    </p>
    <h2 className='text-[17px] font-[620] tracking-[-0.35px]' id='launch-heading'>
      {workflow?.name ?? 'No workflow registered'}
    </h2>
    <p className='text-[13px] text-muted-foreground max-[1100px]:text-[11px]'>
      Each run keeps its starting version and immutable graph.
    </p>
  </div>
)

const launchHeading = (workflow: WorkflowSummary | undefined): ReactElement => (
  <div>
    <span className='grid size-[44px] place-items-center rounded-[9px] border border-[#e0ece3] bg-[#edf5ef] text-[#3c7457] dark:border-border dark:bg-secondary dark:text-[#b0e6c6] max-[1100px]:hidden'>
      <GitBranch size={20} />
    </span>
    {launchDescription(workflow)}
  </div>
)

const noInputs: WorkflowSummary['inputs'] = []
const noVersions: WorkflowSummary['versions'] = []

type WorkflowLaunchProps = LaunchControls & Readonly<{ workflow: WorkflowSummary | undefined }>

// oxlint-disable-next-line eslint/func-style -- The shared React rule requires a declaration for named components.
export function WorkflowLaunch({
  canStart,
  inputs,
  onInput,
  onStart,
  onVersion,
  pending,
  version,
  workflow,
}: WorkflowLaunchProps): ReactElement {
  const hasInputs = Predicate.isNotNullish(workflow) && Array.isReadonlyArrayNonEmpty(workflow.inputs)
  return (
    <section
      className={`mb-[27px] flex justify-between gap-5 rounded-[10px] border border-border bg-card p-[23px] max-[1100px]:items-start max-[620px]:mb-5 max-[620px]:flex-col max-[620px]:gap-[17px] max-[620px]:p-5 ${hasInputs ? 'flex-wrap items-start' : 'items-center'} [&>div]:flex [&>div]:items-center [&>div]:gap-[15px] max-[1100px]:[&>div]:gap-2.5 [&_label]:mr-[3px] [&_label]:text-[11px] [&_label]:text-[#75847a] dark:[&_label]:text-muted-foreground [&_h2]:mb-[3px] [&_button]:h-[33px] [&_button]:px-3.5 [&_button]:text-[12px] [&_input]:w-full [&_input]:min-w-0 [&_input]:rounded-md [&_input]:border [&_input]:border-border [&_input]:bg-card [&_input]:px-2.5 [&_input]:py-2 [&_input]:text-[12px] [&_textarea]:min-h-28 [&_textarea]:w-full [&_textarea]:min-w-0 [&_textarea]:resize-y [&_textarea]:rounded-md [&_textarea]:border [&_textarea]:border-border [&_textarea]:bg-card [&_textarea]:px-2.5 [&_textarea]:py-2 [&_textarea]:text-[12px]`}
      data-has-inputs={hasInputs}
      aria-labelledby='launch-heading'
    >
      {launchHeading(workflow)}
      <LaunchForm
        canStart={canStart}
        fields={workflow?.inputs ?? noInputs}
        hasInputs={hasInputs}
        inputs={inputs}
        onInput={onInput}
        onStart={onStart}
        onVersion={onVersion}
        pending={pending}
        version={version}
        versions={workflow?.versions ?? noVersions}
        versionDisabled={pending || Predicate.isNullish(workflow)}
      />
    </section>
  )
}
