import type { ComponentProps, JSX } from 'react'

import { cn } from '@/core/worker/frontend/feature/lib/utils'

export const CardHeader = ({ className, ...props }: ComponentProps<'div'>): JSX.Element => (
  <div
    data-slot='card-header'
    className={cn(
      'group/card-header @container/card-header grid auto-rows-min items-start gap-1 rounded-t-xl px-(--card-spacing) has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] [.border-b]:pb-(--card-spacing)',
      className,
    )}
    // oxlint-disable-next-line react/jsx-props-no-spreading -- Forward native div attributes and React refs through the shadcn card slot.
    {...props}
  />
)
