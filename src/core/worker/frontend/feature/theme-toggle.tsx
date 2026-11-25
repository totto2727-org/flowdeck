'use client'

import { Effect } from 'effect'
import { Moon, Sun } from 'lucide-react'
import { useCallback, useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'

import { Button } from './components/generated/button.tsx'
import { browserTheme, selectTheme, serverTheme, subscribeTheme } from './theme.ts'

// oxlint-disable-next-line eslint/func-style -- The React preset requires named component declarations.
export function ThemeToggle({ disabled }: Readonly<{ disabled: boolean }>): ReactElement {
  const theme = useSyncExternalStore(subscribeTheme, browserTheme, serverTheme)
  const toggleTheme = useCallback(() => {
    // oxlint-disable-next-line rules/no-effect-runtime-run -- The click starts an independent browser theme update before the next paint.
    Effect.runSync(selectTheme(theme === 'dark' ? 'light' : 'dark'))
  }, [theme])

  return (
    <Button
      type='button'
      variant='outline'
      // oxlint-disable-next-line react/forbid-component-props -- The shared Button slot supports consumer sizing, including this control's minimum touch target.
      className='min-h-[36px] min-w-[44px] text-[11px]'
      data-testid='theme-toggle'
      aria-label='Dark mode'
      aria-pressed={theme === 'dark'}
      disabled={disabled}
      onClick={toggleTheme}
    >
      {theme === 'dark' ? <Moon aria-hidden='true' /> : <Sun aria-hidden='true' />}
      <span>{theme === 'dark' ? 'Dark' : 'Light'}</span>
    </Button>
  )
}
