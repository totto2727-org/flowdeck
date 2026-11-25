import type { ComponentProps, JSX } from 'react'

import { cn } from '@/core/worker/frontend/feature/lib/utils'

// oxlint-disable-next-line eslint/func-style -- Keep the named React component declaration required by the shared preset.
export function CardContent({ className, ...props }: ComponentProps<'div'>): JSX.Element {
  return (
    <div
      data-slot='card-content'
      className={cn('px-(--card-spacing)', className)}
      // oxlint-disable-next-line react/jsx-props-no-spreading -- Forward native div attributes and React refs through the shadcn card slot.
      {...props}
    />
  )
}
