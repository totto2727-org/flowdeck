import { expect, test } from '@playwright/test'
import { Array } from 'effect'

test('development task inputs are usable without starting an agent', async ({ page }, info) => {
  let pageErrors: ReadonlyArray<string> = []
  page.on('pageerror', (error) => {
    pageErrors = Array.append(pageErrors, error.message)
  })
  await page.goto('/')
  await page
    .getByRole('navigation', { name: 'Registered workflows' })
    .getByRole('button', { name: 'Pi development' })
    .click()
  const repository = page.getByLabel('Public GitHub repository', { exact: true })
  const task = page.getByLabel('Development task', { exact: true })
  await expect(repository).toBeVisible()
  await expect(task).toBeVisible()
  await repository.fill('https://github.com/totto2727-org/template-vite-plus-lib')
  await task.fill('Add an add function and run its focused tests in the same checkout.')
  await expect(repository).toHaveValue('https://github.com/totto2727-org/template-vite-plus-lib')
  await expect(task).toHaveValue('Add an add function and run its focused tests in the same checkout.')
  await expect(page.getByLabel('Version', { exact: true }).getByRole('option')).toHaveCount(1)
  await expect(page.getByLabel('Version', { exact: true })).toHaveValue('1.0.0')
  await expect(page.getByRole('button', { name: 'Start run', exact: true })).toBeEnabled()

  await page
    .getByRole('navigation', { name: 'Registered workflows' })
    .getByRole('button', { name: 'Release checkpoint' })
    .click()
  await expect(repository).toHaveCount(0)
  await expect(task).toHaveCount(0)
  await expect(page.getByLabel('Version', { exact: true }).getByRole('option')).toHaveCount(2)
  await page.getByLabel('Version', { exact: true }).selectOption('2.0.0')
  await page
    .getByRole('navigation', { name: 'Registered workflows' })
    .getByRole('button', { name: 'Pi development' })
    .click()
  await expect(repository).toHaveValue('')
  await expect(task).toHaveValue('')
  await expect(page.getByLabel('Version', { exact: true })).toHaveValue('1.0.0')
  await repository.fill('https://github.com/totto2727-org/template-vite-plus-lib')
  await task.fill('Add an add function and run its focused tests in the same checkout.')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: info.outputPath('development-form.png'), fullPage: true })
  expect(pageErrors).toEqual([])
})

// Playwright's Page API is the browser automation boundary, not an application HTTP client.
Array.map(['1.0.0', '2.0.0'] as const, (version) => {
  test(`${version} persists its checkpoint and resumes through the real Worker bindings`, async ({ page }, info) => {
    let pageErrors: ReadonlyArray<string> = []
    page.on('pageerror', (error) => {
      pageErrors = Array.append(pageErrors, error.message)
    })
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible()
    await page.getByLabel('Version', { exact: true }).selectOption(version)
    await page.getByRole('button', { name: 'Start run', exact: true }).click()
    await expect(page.getByText('Waiting for an explicit resume', { exact: true })).toBeVisible()
    await expect(page.getByText(`Resume continues this run with ${version}.`, { exact: false })).toBeVisible()

    const runs = page.getByRole('list', { name: 'Persisted runs' })
    const runLabel = await runs.getByRole('button', { pressed: true }).locator('code').innerText()
    const graph = page.getByRole('region', { name: 'Workflow graph', exact: true })
    await expect(page.getByRole('main')).toHaveAttribute('aria-busy', 'false')
    const firstNode = graph.getByRole('button').first()
    await firstNode.focus()
    await expect(firstNode).toBeFocused()
    await firstNode.press('Enter')
    await expect(firstNode).toHaveAttribute('aria-pressed', 'true')
    await expect(firstNode).toHaveAttribute('data-state', 'succeeded')
    await page.keyboard.press('ArrowRight')
    await expect(graph.getByRole('button').nth(1)).toBeFocused()
    await expect(graph.getByRole('button').nth(1)).toHaveAttribute('aria-pressed', 'true')
    await expect(graph.getByRole('button').nth(1)).toHaveAttribute('data-state', 'waiting')

    await page.getByRole('button', { name: /^State / }).click()
    await expect(page.getByLabel('Committed run state')).toContainText('Waiting')
    await expect(page.getByLabel('Committed run state')).toContainText(version)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: info.outputPath(`${version}-waiting.png`), fullPage: true })

    // A page reload cannot implicitly resume a checkpoint or lose the selected implementation version.
    await page.reload()
    await runs.getByRole('button').filter({ hasText: runLabel }).click()
    await expect(page.getByText(`Resume continues this run with ${version}.`, { exact: false })).toBeVisible()
    await page.getByRole('button', { name: /^State / }).click()
    await expect(page.getByLabel('Committed run state')).toContainText('Waiting')
    await page.getByRole('button', { name: 'Resume run', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Resume run', exact: true })).toHaveCount(0)
    await expect(page.getByRole('status')).toContainText('completed')

    // Re-open this exact run, not another completed run retained by a previous test.
    await page.reload()
    const persistedRun = runs.getByRole('button').filter({ hasText: runLabel })
    await expect(persistedRun.getByText('completed', { exact: true })).toBeVisible()
    await persistedRun.click()
    await expect(graph.getByRole('button').last()).toHaveAttribute('data-state', 'succeeded')
    await page.getByRole('button', { name: /^State / }).click()
    await expect(page.getByLabel('Committed run state')).toContainText('Completed')
    await expect(page.getByLabel('Committed run state')).toContainText(version)
    await page.getByRole('button', { name: /^Events / }).click()
    await expect(
      page.getByRole('region', { name: 'Persisted events' }).getByText('run completed', { exact: true }),
    ).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: info.outputPath(`${version}-completed.png`), fullPage: true })
    expect(pageErrors, 'The browser must not have uncaught page errors').toEqual([])
  })
})
