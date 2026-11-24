import { Array } from 'effect'
import { Play } from 'lucide-react'
import { useCallback } from 'react'
import type { ChangeEvent, ReactElement, SubmitEvent } from 'react'

import { Button } from './components/generated/button.tsx'
import type { WorkflowSummary } from './view-model.ts'
import { WorkflowInputField } from './workflow-input-field.tsx'
import type { ChangeInput } from './workflow-input-field.tsx'

type VersionSelectProps = Readonly<{
  disabled: boolean
  onChange: (event: ChangeEvent<HTMLSelectElement>) => void
  value: string
  versions: WorkflowSummary['versions']
}>

const versionSelect = ({ disabled, onChange, value, versions }: VersionSelectProps): ReactElement => (
  <select
    className='h-[33px] rounded-md border border-border bg-card py-1.5 pr-6 pl-2.5 text-[12px] text-[#485d4f] dark:text-foreground'
    id='workflow-version'
    value={value}
    disabled={disabled}
    onChange={onChange}
  >
    {Array.map(versions, (item) => (
      <option key={item} value={item}>
        {item}
      </option>
    ))}
  </select>
)

export type LaunchControls = Readonly<{
  canStart: boolean
  inputs: Readonly<Record<string, string>>
  onInput: ChangeInput
  onStart: () => void
  onVersion: (version: string) => void
  pending: boolean
  version: string
}>

type LaunchFormProps = LaunchControls &
  Readonly<{
    fields: WorkflowSummary['inputs']
    hasInputs: boolean
    versionDisabled: boolean
    versions: WorkflowSummary['versions']
  }>

// oxlint-disable-next-line eslint/func-style -- The shared React rule requires a declaration for named components.
export function LaunchForm({
  canStart,
  fields,
  hasInputs,
  inputs,
  onInput,
  onStart,
  onVersion,
  pending,
  version,
  versionDisabled,
  versions,
}: LaunchFormProps): ReactElement {
  const submit = useCallback(
    (event: SubmitEvent<HTMLFormElement>): void => {
      event.preventDefault()
      onStart()
    },
    [onStart],
  )
  const changeVersion = useCallback(
    (event: ChangeEvent<HTMLSelectElement>): void => {
      onVersion(event.target.value)
    },
    [onVersion],
  )
  return (
    <form
      className={`gap-[9px] max-[1100px]:flex-wrap max-[1100px]:justify-end max-[620px]:w-full max-[620px]:justify-start ${hasInputs ? 'grid min-w-0 max-w-lg flex-[1_1_20rem] grid-cols-[minmax(0,1fr)] [&_button]:ml-0 [&_button]:justify-self-start' : 'flex shrink-0 items-center max-[620px]:[&_button]:ml-auto'}`}
      onSubmit={submit}
    >
      <label htmlFor='workflow-version'>Version</label>
      {versionSelect({ disabled: versionDisabled, onChange: changeVersion, value: version, versions })}
      {Array.map(fields, (input) => (
        <WorkflowInputField
          key={input.name}
          input={input}
          onChange={onInput}
          pending={pending}
          value={inputs[input.name] ?? ''}
        />
      ))}
      <Button type='submit' disabled={!canStart || pending}>
        <Play size={15} />
        Start run
      </Button>
    </form>
  )
}
