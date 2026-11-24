import type { ReactElement, ReactNode } from 'react'

export const detailField = (label: string, value: ReactNode): ReactElement => (
  <div>
    <dt>{label}</dt>
    <dd>{value}</dd>
  </div>
)
