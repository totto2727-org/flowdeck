import type { ComponentProps, JSX } from 'react'

import { cn } from '@/core/worker/frontend/feature/lib/utils'

export const CardContent = ({ className, ...props }: ComponentProps<'div'>): JSX.Element => (
  <div
    data-slot='card-content'
    className={cn('px-(--card-spacing)', className)}
    // oxlint-disable-next-line react/jsx-props-no-spreading -- Forward native div attributes and React refs through the shadcn card slot.
    {...props}
  />
)
