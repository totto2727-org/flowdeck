import { runInNewContext } from 'node:vm'

import { Effect } from 'effect'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { browserTheme, selectTheme, serverTheme, subscribeTheme, themeBootstrap, themeStorageKey } from './theme'
import { ThemeToggle } from './theme-toggle'

function browser(stored: string | null = null, storageDenied = false) {
  const values = new Map<string, string>(stored === null ? [] : [[themeStorageKey, stored]])
  const classes = new Set(['dark'])
  const meta = {
    content: '#101714',
    setAttribute: (_name: string, value: string) => {
      meta.content = value
    },
  }
  const document = {
    documentElement: {
      dataset: { theme: 'dark' },
      classList: {
        toggle: (name: string, enabled: boolean) => (enabled ? classes.add(name) : classes.delete(name)),
      },
    },
    querySelector: () => meta,
  }
  const storage = {
    getItem: (key: string) => {
      if (storageDenied) throw new Error('Storage denied')
      return values.get(key) ?? null
    },
    setItem: (key: string, value: string) => {
      if (storageDenied) throw new Error('Storage denied')
      values.set(key, value)
    },
  }
  class ThemeWindow extends EventTarget {
    readonly localStorage = storage
  }
  const window = new ThemeWindow()
  return { document, window, localStorage: storage, classes, meta, values }
}

afterEach(() => vi.unstubAllGlobals())

describe('theme before first paint', () => {
  it.each([
    { stored: null, expected: 'dark' },
    { stored: 'dark', expected: 'dark' },
    { stored: 'light', expected: 'light' },
    { stored: 'system', expected: 'dark' },
    { stored: '<script>alert(1)</script>', expected: 'dark' },
  ])('applies $expected synchronously for stored $stored', ({ stored, expected }) => {
    const boundary = browser(stored)
    runInNewContext(themeBootstrap, boundary)
    expect(boundary.document.documentElement.dataset.theme).toBe(expected)
    expect(boundary.classes.has('dark')).toBe(expected === 'dark')
    expect(boundary.meta.content).toBe(expected === 'dark' ? '#101714' : '#f7f9f8')
  })

  it('keeps dark when storage access is denied', () => {
    const boundary = browser('light', true)
    expect(() => runInNewContext(themeBootstrap, boundary)).not.toThrow()
    expect(boundary.document.documentElement.dataset.theme).toBe('dark')
    expect(boundary.classes.has('dark')).toBe(true)
  })

  it('renders the same accessible dark toggle on the server without browser APIs', () => {
    expect(serverTheme()).toBe('dark')
    const markup = renderToStaticMarkup(createElement(ThemeToggle, { disabled: true }))
    expect(markup).toContain('aria-label="Dark mode"')
    expect(markup).toContain('aria-pressed="true"')
    expect(markup).toContain('disabled=""')
    expect(markup).toContain('>Dark</span>')
  })
})

describe('theme browser boundary', () => {
  it('switches both ways, notifies React, and restores the selection on reload', () => {
    const boundary = browser()
    vi.stubGlobal('document', boundary.document)
    vi.stubGlobal('window', boundary.window)
    const notify = vi.fn()
    const unsubscribe = subscribeTheme(notify)
    try {
      Effect.runSync(selectTheme('light'))
      expect(browserTheme()).toBe('light')
      expect(boundary.classes.has('dark')).toBe(false)
      expect(boundary.meta.content).toBe('#f7f9f8')
      expect(boundary.values.get(themeStorageKey)).toBe('light')
      expect(notify).toHaveBeenCalledTimes(1)
      const reloaded = browser(boundary.localStorage.getItem(themeStorageKey))
      runInNewContext(themeBootstrap, reloaded)
      expect(reloaded.document.documentElement.dataset.theme).toBe('light')

      Effect.runSync(selectTheme('dark'))
      expect(browserTheme()).toBe('dark')
      expect(boundary.classes.has('dark')).toBe(true)
      expect(boundary.meta.content).toBe('#101714')
      expect(boundary.values.get(themeStorageKey)).toBe('dark')
      expect(notify).toHaveBeenCalledTimes(2)
    } finally {
      unsubscribe()
    }
    Effect.runSync(selectTheme('light'))
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('keeps the toggle functional when persistence is denied', () => {
    const boundary = browser(null, true)
    vi.stubGlobal('document', boundary.document)
    vi.stubGlobal('window', boundary.window)
    expect(() => Effect.runSync(selectTheme('light'))).not.toThrow()
    expect(browserTheme()).toBe('light')
    expect(boundary.classes.has('dark')).toBe(false)
    expect(boundary.meta.content).toBe('#f7f9f8')
    expect(boundary.values.size).toBe(0)
    Effect.runSync(selectTheme('dark'))
    expect(browserTheme()).toBe('dark')
  })
})
