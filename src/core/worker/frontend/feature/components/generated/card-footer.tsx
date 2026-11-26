import type { ComponentProps, JSX } from 'react'

import { cn } from '@/core/worker/frontend/feature/lib/utils'

export const CardFooter = ({ className, ...props }: ComponentProps<'div'>): JSX.Element => (
  <div
    data-slot='card-footer'
    className={cn('flex items-center rounded-b-xl border-t bg-muted/50 p-(--card-spacing)', className)}
    // oxlint-disable-next-line react/jsx-props-no-spreading -- Forward native div attributes and React refs through the shadcn card slot.
    {...props}
  />
)
