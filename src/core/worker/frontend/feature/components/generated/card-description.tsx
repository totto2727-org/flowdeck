import type { ComponentProps, JSX } from 'react'

import { cn } from '@/core/worker/frontend/feature/lib/utils'

// oxlint-disable-next-line eslint/func-style -- Keep the named React component declaration required by the shared preset.
export const CardDescription = ({ className, ...props }: ComponentProps<'div'>): JSX.Element => (
  <div
    data-slot='card-description'
    className={cn('text-sm text-muted-foreground', className)}
    // oxlint-disable-next-line react/jsx-props-no-spreading -- Forward native div attributes and React refs through the shadcn card slot.
    {...props}
  />
)
