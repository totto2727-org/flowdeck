import { Effect } from 'effect'

export type Theme = 'dark' | 'light'

export const themeStorageKey = 'flowdeck.theme'
const themeChangeEvent = 'flowdeck:theme-change'

// This synchronous browser boundary runs in <head>, before content can paint.
// Storage can be denied by browser policy, so dark remains the safe default.
export const themeBootstrap = `(() => {
  let theme = 'dark'
  try { if (localStorage.getItem('flowdeck.theme') === 'light') theme = 'light' } catch {}
  document.documentElement.dataset['theme'] = theme
  document.documentElement.classList.toggle('dark', theme === 'dark')
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#101714' : '#f7f9f8')
})()`

export const serverTheme = (): Theme => 'dark'

// React and the DOM/storage APIs meet only at this browser adapter.
export const browserTheme = (): Theme => (document.documentElement.dataset['theme'] === 'light' ? 'light' : 'dark')

export const subscribeTheme = (notify: () => void) => {
  window.addEventListener(themeChangeEvent, notify)
  return () => window.removeEventListener(themeChangeEvent, notify)
}

export const selectTheme = (theme: Theme) =>
  Effect.gen(function* () {
    yield* Effect.sync(() => {
      document.documentElement.dataset['theme'] = theme
      document.documentElement.classList.toggle('dark', theme === 'dark')
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', theme === 'dark' ? '#101714' : '#f7f9f8')
      window.dispatchEvent(new Event(themeChangeEvent))
    })
    // A denied write must not prevent the current page from switching themes.
    yield* Effect.try(() => window.localStorage.setItem(themeStorageKey, theme)).pipe(Effect.ignore)
  })
