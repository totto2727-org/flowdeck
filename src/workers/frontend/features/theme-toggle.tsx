'use client'

import { Effect } from 'effect'
import { Moon, Sun } from 'lucide-react'
import { useSyncExternalStore } from 'react'

import { Button } from './components/generated/button'
import { browserTheme, selectTheme, serverTheme, subscribeTheme } from './theme'

export function ThemeToggle({ disabled = false }: { readonly disabled?: boolean }) {
  const theme = useSyncExternalStore(subscribeTheme, browserTheme, serverTheme)
  return (
    <Button
      type='button'
      variant='outline'
      className='theme-toggle'
      data-testid='theme-toggle'
      aria-label='Dark mode'
      aria-pressed={theme === 'dark'}
      disabled={disabled}
      onClick={() => Effect.runSync(selectTheme(theme === 'dark' ? 'light' : 'dark'))}
    >
      {theme === 'dark' ? <Moon aria-hidden='true' /> : <Sun aria-hidden='true' />}
      <span>{theme === 'dark' ? 'Dark' : 'Light'}</span>
    </Button>
  )
}
