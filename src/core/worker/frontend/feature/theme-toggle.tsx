'use client'

import { Effect } from 'effect'
import { Moon, Sun } from 'lucide-react'
import { useSyncExternalStore } from 'react'

import { Button } from './components/generated/button.tsx'
import { browserTheme, selectTheme, serverTheme, subscribeTheme } from './theme.ts'

export function ThemeToggle({ disabled }: Readonly<{ disabled: boolean }>) {
  const theme = useSyncExternalStore(subscribeTheme, browserTheme, serverTheme)
  return (
    <Button
      type='button'
      variant='outline'
      className='min-h-[36px] min-w-[44px] text-[11px]'
      data-testid='theme-toggle'
      aria-label='Dark mode'
      aria-pressed={theme === 'dark'}
      disabled={disabled}
      onClick={() => {
        Effect.runSync(selectTheme(theme === 'dark' ? 'light' : 'dark'))
      }}
    >
      {theme === 'dark' ? <Moon aria-hidden='true' /> : <Sun aria-hidden='true' />}
      <span>{theme === 'dark' ? 'Dark' : 'Light'}</span>
    </Button>
  )
}
