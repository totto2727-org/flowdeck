import { mergeProps } from '@base-ui/react/merge-props'
import { useRender } from '@base-ui/react/use-render'
import type { VariantProps } from 'class-variance-authority'
import type { JSX } from 'react'

import { cn } from '@/core/worker/frontend/feature/lib/utils'

import { badgeVariants } from './badge-variants.ts'

// oxlint-disable-next-line eslint/func-style -- Keep the named React component declaration required by the shared preset.
export function Badge({
  className,
  variant = 'default',
  render,
  ...props
}: useRender.ComponentProps<'span'> & VariantProps<typeof badgeVariants>): JSX.Element {
  const classes = cn(badgeVariants({ variant }), className)
  const attributes = mergeProps<'span'>({ className: classes }, props)
  return useRender({
    defaultTagName: 'span',
    props: attributes,
    render,
    state: { slot: 'badge', variant },
  })
}
