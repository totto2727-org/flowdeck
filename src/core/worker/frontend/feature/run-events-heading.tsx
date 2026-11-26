import type { ChangeEvent, ReactElement } from 'react'

type HeadingProps = Readonly<{
  checked: boolean
  count: number
  disabled: boolean
  onChange: (event: ChangeEvent<HTMLInputElement>) => void
}>

export const RunEventsHeading = ({ checked, count, disabled, onChange }: HeadingProps): ReactElement => {
  const filter = (
    <label className='flex items-center gap-1.5 text-[9px] whitespace-nowrap text-[#788d7e] dark:text-muted-foreground'>
      <input className='accent-primary' type='checkbox' checked={checked} disabled={disabled} onChange={onChange} />
      Selected node only
    </label>
  )
  return (
    <div className='flex items-center justify-between gap-3.5'>
      <p className='text-[13px] text-muted-foreground'>{count} committed events · ordered by sequence</p>
      {filter}
    </div>
  )
}
