// oxlint-disable-next-line rules/no-node-imports -- An isolated VM evaluates the exact inline script used before browser hydration.
import { runInNewContext } from 'node:vm'

import { live } from '@effect/vitest'
import { Effect, Predicate } from 'effect'
import type { Scope } from 'effect'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vite-plus/test'

import { ThemeToggle } from './theme-toggle.tsx'
import { browserTheme, selectTheme, serverTheme, subscribeTheme, themeBootstrap, themeStorageKey } from './theme.ts'
import type { Theme } from './theme.ts'

const darkPage = { dark: true, meta: '#101714', theme: 'dark' } as const
const lightPage = { dark: false, meta: '#f7f9f8', theme: 'light' } as const

type ThemeStorage = Pick<Storage, 'getItem' | 'setItem'>

const storageError = (): DOMException => new DOMException('Storage denied', 'SecurityError')

const makeStorage = (values: Map<string, string>, denied: boolean): ThemeStorage => ({
  getItem: (key) => {
    if (denied) {
      throw storageError()
    }
    // oxlint-disable-next-line unicorn/no-null -- Storage.getItem returns native null for a missing key.
    return values.get(key) ?? null
  },
  setItem: (key, value) => {
    if (denied) {
      throw storageError()
    }
    values.set(key, value)
  },
})

interface DocumentFixture {
  documentElement: {
    classList: { toggle: (name: string, enabled: boolean) => boolean }
    dataset: { theme: string }
  }
  querySelector: () => { content: string; setAttribute: (name: string, value: string) => void }
}

interface ThemeBrowser {
  classes: Set<string>
  document: DocumentFixture
  events: EventTarget
  localStorage: ThemeStorage
  meta: ReturnType<DocumentFixture['querySelector']>
  values: Map<string, string>
}

const makeDocument = (classes: Set<string>, meta: ThemeBrowser['meta']): DocumentFixture => ({
  documentElement: {
    classList: {
      toggle: (name, enabled) => {
        if (enabled) {
          classes.add(name)
          return true
        }
        classes.delete(name)
        return false
      },
    },
    dataset: { theme: 'dark' },
  },
  querySelector: () => meta,
})

const browser = (stored?: string, denied = false): ThemeBrowser => {
  const values = new Map<string, string>(Predicate.isNullish(stored) ? [] : [[themeStorageKey, stored]])
  const classes = new Set(['dark'])
  const meta = {
    content: '#101714',
    setAttribute: (_name: string, value: string) => {
      meta.content = value
    },
  }
  const document = makeDocument(classes, meta)
  const localStorage = makeStorage(values, denied)
  const events = new EventTarget()
  return { classes, document, events, localStorage, meta, values }
}

const pageState = ({
  classes,
  document,
  meta,
}: ThemeBrowser): Readonly<{
  dark: boolean
  meta: string
  theme: string
}> => ({
  dark: classes.has('dark'),
  meta: meta.content,
  theme: document.documentElement.dataset.theme,
})

const applyBootstrap = (boundary: ThemeBrowser): void => {
  runInNewContext(themeBootstrap, boundary)
}

describe('theme before first paint', () => {
  test.each([
    { expected: darkPage, stored: undefined },
    { expected: darkPage, stored: 'dark' },
    { expected: lightPage, stored: 'light' },
    { expected: darkPage, stored: 'system' },
    { expected: darkPage, stored: '<script>alert(1)</script>' },
  ])('applies the theme synchronously for stored $stored', ({ expected, stored }) => {
    const boundary = browser(stored)
    applyBootstrap(boundary)
    expect(pageState(boundary)).toStrictEqual(expected)
  })

  test('keeps dark when storage access is denied', () => {
    const boundary = browser('light', true)
    expect(() => {
      applyBootstrap(boundary)
    }).not.toThrow()
    expect(pageState(boundary)).toStrictEqual(darkPage)
  })

  test('renders the same accessible dark toggle on the server without browser APIs', () => {
    const markup = renderToStaticMarkup(createElement(ThemeToggle, { disabled: true }))
    expect({
      dark: markup.includes('>Dark</span>'),
      disabled: markup.includes('disabled=""'),
      labelled: markup.includes('aria-label="Dark mode"'),
      pressed: markup.includes('aria-pressed="true"'),
      theme: serverTheme(),
    }).toStrictEqual({ dark: true, disabled: true, labelled: true, pressed: true, theme: 'dark' })
  })
})

const installBrowser = (boundary: ThemeBrowser): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      vi.stubGlobal('document', boundary.document)
      vi.stubGlobal('localStorage', boundary.localStorage)
      vi.stubGlobal('addEventListener', boundary.events.addEventListener.bind(boundary.events))
      vi.stubGlobal('removeEventListener', boundary.events.removeEventListener.bind(boundary.events))
      vi.stubGlobal('dispatchEvent', boundary.events.dispatchEvent.bind(boundary.events))
    }),
    () =>
      Effect.sync(() => {
        vi.unstubAllGlobals()
      }),
  )

const observeChanges = Effect.gen(function* () {
  const notify = vi.fn<() => void>()
  const unsubscribe = yield* Effect.acquireRelease(
    Effect.sync(() => subscribeTheme(notify)),
    (cleanup) => Effect.sync(cleanup),
  )
  return { notify, unsubscribe }
})

const currentTheme = (
  boundary: ThemeBrowser,
): Readonly<{
  page: ReturnType<typeof pageState>
  react: ReturnType<typeof browserTheme>
  stored: string | undefined
}> => ({
  page: pageState(boundary),
  react: browserTheme(),
  stored: boundary.values.get(themeStorageKey),
})

const changedTheme = Effect.fn('flowdeck.test.observeSelectedTheme')(function* (
  boundary: ThemeBrowser,
  notify: () => number,
  theme: Theme,
) {
  yield* selectTheme(theme)
  return { ...currentTheme(boundary), notified: notify() }
})

const reloadTheme = (boundary: ThemeBrowser): ReturnType<typeof pageState> => {
  const reloaded = browser(boundary.localStorage.getItem(themeStorageKey) ?? undefined)
  applyBootstrap(reloaded)
  return pageState(reloaded)
}

describe('theme browser boundary', () => {
  live('switches both ways, notifies React, and restores the selection on reload', () =>
    Effect.gen(function* () {
      const boundary = browser()
      yield* installBrowser(boundary)
      const { notify, unsubscribe } = yield* observeChanges

      const changes = (): number => notify.mock.calls.length
      expect(yield* changedTheme(boundary, changes, 'light')).toStrictEqual({
        notified: 1,
        page: lightPage,
        react: 'light',
        stored: 'light',
      })
      expect(reloadTheme(boundary)).toStrictEqual(lightPage)
      expect(yield* changedTheme(boundary, changes, 'dark')).toStrictEqual({
        notified: 2,
        page: darkPage,
        react: 'dark',
        stored: 'dark',
      })

      unsubscribe()
      yield* selectTheme('light')
      expect(notify).toHaveBeenCalledTimes(2)
    }).pipe(Effect.scoped),
  )

  live('keeps the toggle functional when persistence is denied', () =>
    Effect.gen(function* () {
      const boundary = browser(undefined, true)
      yield* installBrowser(boundary)
      yield* selectTheme('light')
      expect(currentTheme(boundary)).toStrictEqual({ page: lightPage, react: 'light', stored: undefined })
      expect(boundary.values.size).toBe(0)
      yield* selectTheme('dark')
      expect(browserTheme()).toBe('dark')
    }).pipe(Effect.scoped),
  )
})
