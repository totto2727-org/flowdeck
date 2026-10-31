import { expect, test } from '@playwright/test'
import { Array } from 'effect'

test('defaults to dark even with a light OS preference and persists explicit theme choices', async ({ page }, info) => {
  let pageErrors: ReadonlyArray<string> = []
  page.on('pageerror', (error) => {
    pageErrors = Array.append(pageErrors, error.message)
  })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/')
  const root = page.locator('html')
  const toggle = page.getByRole('button', { name: 'Dark mode', exact: true })
  await expect(root).toHaveAttribute('data-theme', 'dark')
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(16, 23, 20)')
  await expect(toggle).toBeEnabled()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await page.screenshot({ path: info.outputPath('default-dark.png'), fullPage: true })

  await toggle.click()
  await expect(root).toHaveAttribute('data-theme', 'light')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(247, 249, 248)')
  await page.reload()
  await expect(root).toHaveAttribute('data-theme', 'light')
  await expect(toggle).toBeEnabled()
  await page.screenshot({ path: info.outputPath('selected-light.png'), fullPage: true })

  await toggle.focus()
  await page.keyboard.press('Space')
  await expect(root).toHaveAttribute('data-theme', 'dark')
  await page.reload()
  await expect(root).toHaveAttribute('data-theme', 'dark')
  expect(pageErrors).toEqual([])
})

test('saved light preference is applied without hydration errors', async ({ page }) => {
  let pageErrors: ReadonlyArray<string> = []
  page.on('pageerror', (error) => {
    pageErrors = Array.append(pageErrors, error.message)
  })
  // Browser persistence and DOM access are the Playwright/browser boundary.
  await page.addInitScript(() => window.localStorage.setItem('flowdeck.theme', 'light'))
  await page.goto('/')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(page.getByRole('button', { name: 'Dark mode', exact: true })).toHaveAttribute('aria-pressed', 'false')
  expect(pageErrors).toEqual([])
})

test('blocked browser storage does not prevent theme switching', async ({ page }) => {
  let pageErrors: ReadonlyArray<string> = []
  page.on('pageerror', (error) => {
    pageErrors = Array.append(pageErrors, error.message)
  })
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new DOMException('Storage is blocked', 'SecurityError')
      },
    })
  })
  await page.goto('/')
  const root = page.locator('html')
  const toggle = page.getByRole('button', { name: 'Dark mode', exact: true })
  await expect(root).toHaveAttribute('data-theme', 'dark')
  await expect(toggle).toBeEnabled()
  await toggle.click()
  await expect(root).toHaveAttribute('data-theme', 'light')
  await page.reload()
  await expect(root).toHaveAttribute('data-theme', 'dark')
  expect(pageErrors).toEqual([])
})

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false })
  test('server-rendered page is already dark', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(16, 23, 20)')
    await expect(page.getByRole('button', { name: 'Dark mode', exact: true })).toBeDisabled()
  })
})
