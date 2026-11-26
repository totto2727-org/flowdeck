import { useCallback } from 'react'
import type { ChangeEvent, ReactElement } from 'react'

import type { WorkflowSummary } from './view-model.ts'

export type ChangeInput = (name: string, value: string) => void

type WorkflowInputFieldProps = Readonly<{
  input: WorkflowSummary['inputs'][number]
  onChange: ChangeInput
  pending: boolean
  value: string
}>

export const WorkflowInputField = ({ input, onChange, pending, value }: WorkflowInputFieldProps): ReactElement => {
  const change = useCallback(
    (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      onChange(input.name, event.target.value)
    },
    [input.name, onChange],
  )
  const field =
    input.kind === 'textarea' ? (
      <textarea
        id={input.name}
        name={input.name}
        value={value}
        placeholder={input.placeholder}
        maxLength={input.maxLength}
        required={input.required}
        disabled={pending}
        onChange={change}
      />
    ) : (
      <input
        id={input.name}
        name={input.name}
        type='text'
        value={value}
        placeholder={input.placeholder}
        maxLength={input.maxLength}
        required={input.required}
        disabled={pending}
        onChange={change}
      />
    )
  return (
    <>
      <label htmlFor={input.name}>{input.label}</label>
      {field}
    </>
  )
}
