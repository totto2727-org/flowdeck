import { Button as ButtonPrimitive } from '@base-ui/react/button'
import type { VariantProps } from 'class-variance-authority'
import type { JSX } from 'react'

import { cn } from '@/core/worker/frontend/feature/lib/utils'

import { buttonVariants } from './button-variants.ts'

// oxlint-disable-next-line eslint/func-style -- Keep the named React component declaration required by the shared preset.
export function Button({
  className,
  variant = 'default',
  size = 'default',
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>): JSX.Element {
  const attributes = {
    className: cn(buttonVariants({ className, size, variant })),
    'data-slot': 'button',
    ...props,
  }
  // oxlint-disable-next-line react/jsx-props-no-spreading -- Base UI receives the supported component, DOM and accessibility props intact.
  return <ButtonPrimitive {...attributes} />
}
