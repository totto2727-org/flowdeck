import { expect, test } from '@playwright/test'
import { Array } from 'effect'

// Playwright's Page API is the browser automation boundary, not an application HTTP client.
Array.map(['v1', 'v2'] as const, (version) => {
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
