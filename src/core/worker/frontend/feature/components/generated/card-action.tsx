import type { ComponentProps, JSX } from 'react'

import { cn } from '@/core/worker/frontend/feature/lib/utils'

// oxlint-disable-next-line eslint/func-style -- Keep the named React component declaration required by the shared preset.
export const CardAction = ({ className, ...props }: ComponentProps<'div'>): JSX.Element => (
  <div
    data-slot='card-action'
    className={cn('col-start-2 row-span-2 row-start-1 self-start justify-self-end', className)}
    // oxlint-disable-next-line react/jsx-props-no-spreading -- Forward native div attributes and React refs through the shadcn card slot.
    {...props}
  />
)
