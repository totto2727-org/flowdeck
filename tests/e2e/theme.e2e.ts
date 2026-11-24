import { expect, test } from '@playwright/test'
import type { Locator, Page, TestInfo } from '@playwright/test'

const themeControls = (page: Page): { root: Locator; toggle: Locator } => ({
  root: page.locator('html'),
  toggle: page.getByRole('button', { exact: true, name: 'Dark mode' }),
})

const observePageErrors = (page: Page): string[] => {
  const errors: string[] = []
  page.on('pageerror', (error) => {
    errors.push(error.message)
  })
  return errors
}

const defaultTheme = async (page: Page, info: TestInfo): Promise<void> => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/')
  const { root, toggle } = themeControls(page)
  await expect(root).toHaveAttribute('data-theme', 'dark')
  await expect(root).toHaveCSS('background-color', 'rgb(16, 23, 20)')
  await expect(toggle).toBeEnabled()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await page.screenshot({ fullPage: true, path: info.outputPath('default-dark.png') })
}

const chooseLightAndReload = async (page: Page, info: TestInfo): Promise<void> => {
  const { root, toggle } = themeControls(page)
  await toggle.click()
  await expect(root).toHaveAttribute('data-theme', 'light')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(root).toHaveCSS('background-color', 'rgb(247, 249, 248)')
  await page.reload()
  await expect(root).toHaveAttribute('data-theme', 'light')
  await expect(toggle).toBeEnabled()
  await page.screenshot({ fullPage: true, path: info.outputPath('selected-light.png') })
}

const chooseDarkFromKeyboardAndReload = async (page: Page): Promise<void> => {
  const { root, toggle } = themeControls(page)
  await toggle.focus()
  await page.keyboard.press('Space')
  await expect(root).toHaveAttribute('data-theme', 'dark')
  await page.reload()
  await expect(root).toHaveAttribute('data-theme', 'dark')
}

test('defaults to dark even with a light OS preference and persists explicit theme choices', async ({ page }, info) => {
  const errors = observePageErrors(page)
  await defaultTheme(page, info)
  await chooseLightAndReload(page, info)
  await chooseDarkFromKeyboardAndReload(page)
  expect(errors).toEqual([])
})

test('saved light preference is applied without hydration errors', async ({ page }) => {
  const errors = observePageErrors(page)
  await page.addInitScript(() => {
    globalThis.localStorage.setItem('flowdeck.theme', 'light')
  })
  await page.goto('/')
  const { root, toggle } = themeControls(page)
  await expect(root).toHaveAttribute('data-theme', 'light')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  expect(errors).toEqual([])
})

const openWithoutStorage = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      get() {
        throw new DOMException('Storage is blocked', 'SecurityError')
      },
    })
  })
  await page.goto('/')
}

test('blocked browser storage does not prevent theme switching', async ({ page }) => {
  const errors = observePageErrors(page)
  await openWithoutStorage(page)
  const { root, toggle } = themeControls(page)
  await expect(root).toHaveAttribute('data-theme', 'dark')
  await expect(toggle).toBeEnabled()
  await toggle.click()
  await expect(root).toHaveAttribute('data-theme', 'light')
  await page.reload()
  await expect(root).toHaveAttribute('data-theme', 'dark')
  expect(errors).toEqual([])
})

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false })
  test('server-rendered page is already dark', async ({ page }) => {
    await page.goto('/')
    const { root, toggle } = themeControls(page)
    await expect(root).toHaveAttribute('data-theme', 'dark')
    await expect(root).toHaveCSS('background-color', 'rgb(16, 23, 20)')
    await expect(toggle).toBeDisabled()
  })
})
