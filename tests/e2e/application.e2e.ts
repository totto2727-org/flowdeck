import { expect, test } from '@playwright/test'
import type { Locator, Page, TestInfo } from '@playwright/test'
import { Array } from 'effect'

const noMatches = 0
const singleVersion = 1
const releaseVersions = 2
const approvalNodeIndex = 1
const developmentVersion = '1.0.0'
const demoVersions = ['1.0.0', '2.0.0'] as const
type DemoVersion = (typeof demoVersions)[number]

const repositoryUrl = 'https://github.com/totto2727-org/template-vite-plus-lib'
const developmentTask = 'Add an add function and run its focused tests in the same checkout.'

const reportPageErrors = (page: Page): string[] => {
  const errors: string[] = []
  page.on('pageerror', (error) => {
    errors.push(error.message)
  })
  return errors
}

const chooseWorkflow = async (page: Page, name: string): Promise<void> => {
  const workflows = page.getByRole('navigation', { name: 'Registered workflows' })
  await workflows.getByRole('button', { name }).click()
}

const versionInput = (page: Page): Locator => page.getByLabel('Version', { exact: true })
const startButton = (page: Page): Locator => page.getByRole('button', { exact: true, name: 'Start run' })
const resumeButton = (page: Page): Locator => page.getByRole('button', { exact: true, name: 'Resume run' })

type DevelopmentControls = Readonly<{ repository: Locator; task: Locator; version: Locator }>
const developmentControls = (page: Page): DevelopmentControls => ({
  repository: page.getByLabel('Public GitHub repository', { exact: true }),
  task: page.getByLabel('Development task', { exact: true }),
  version: versionInput(page),
})

const fillDevelopmentForm = async ({ repository, task }: DevelopmentControls): Promise<void> => {
  await repository.fill(repositoryUrl)
  await task.fill(developmentTask)
}

const checkDevelopmentInputs = async (page: Page, controls: DevelopmentControls): Promise<void> => {
  const { repository, task, version } = controls
  await expect(repository).toBeVisible()
  await expect(task).toBeVisible()
  await fillDevelopmentForm(controls)
  await expect(repository).toHaveValue(repositoryUrl)
  await expect(task).toHaveValue(developmentTask)
  await expect(version.getByRole('option')).toHaveCount(singleVersion)
  await expect(version).toHaveValue(developmentVersion)
  await expect(startButton(page)).toBeEnabled()
}

const checkVersionAndFormReset = async (page: Page, controls: DevelopmentControls): Promise<void> => {
  const { repository, task, version } = controls
  await chooseWorkflow(page, 'Release checkpoint')
  await expect(repository).toHaveCount(noMatches)
  await expect(task).toHaveCount(noMatches)
  await expect(version.getByRole('option')).toHaveCount(releaseVersions)
  await version.selectOption('2.0.0')
  await chooseWorkflow(page, 'Pi development')
  await expect(repository).toHaveValue('')
  await expect(task).toHaveValue('')
  await expect(version).toHaveValue(developmentVersion)
}

const recordLayout = async (page: Page, info: TestInfo, image: string): Promise<void> => {
  const fitsViewport = await page.evaluate(() => document.documentElement.scrollWidth <= globalThis.innerWidth)
  expect(fitsViewport).toBe(true)
  await page.screenshot({ fullPage: true, path: info.outputPath(image) })
}

test('development task inputs are usable without starting an agent', async ({ page }, info) => {
  const errors = reportPageErrors(page)
  await page.goto('/')
  await chooseWorkflow(page, 'Pi development')
  const controls = developmentControls(page)
  await checkDevelopmentInputs(page, controls)
  await checkVersionAndFormReset(page, controls)
  await fillDevelopmentForm(controls)
  await recordLayout(page, info, 'development-form.png')
  expect(errors).toEqual([])
})

const persistedRuns = (page: Page): Locator => page.getByRole('list', { name: 'Persisted runs' })
const workflowGraph = (page: Page): Locator => page.getByRole('region', { exact: true, name: 'Workflow graph' })
const continuation = (page: Page, version: DemoVersion): Locator =>
  page.getByText(`Resume continues this run with ${version}.`, { exact: false })

const startAndWait = async (page: Page, version: DemoVersion): Promise<string> => {
  await page.goto('/')
  await expect(page.getByRole('heading', { exact: true, name: 'Overview' })).toBeVisible()
  await versionInput(page).selectOption(version)
  await startButton(page).click()
  await expect(page.getByText('Waiting for an explicit resume', { exact: true })).toBeVisible()
  await expect(continuation(page, version)).toBeVisible()
  const selected = persistedRuns(page).getByRole('button', { pressed: true }).locator('code')
  // oxlint-disable-next-line unicorn/prefer-dom-node-text-content -- Use the rendered run label that the browser exposes to readers.
  return selected.innerText()
}

const checkApprovalNode = async (approval: Locator): Promise<void> => {
  await expect(approval).toBeFocused()
  await expect(approval).toHaveAttribute('aria-pressed', 'true')
  await expect(approval).toHaveAttribute('data-state', 'waiting')
}

const checkGraphKeyboard = async (page: Page): Promise<void> => {
  const nodes = workflowGraph(page).getByRole('button')
  const firstNode = nodes.first()
  await expect(page.getByRole('main')).toHaveAttribute('aria-busy', 'false')
  await firstNode.focus()
  await expect(firstNode).toBeFocused()
  await firstNode.press('Enter')
  await expect(firstNode).toHaveAttribute('aria-pressed', 'true')
  await expect(firstNode).toHaveAttribute('data-state', 'succeeded')
  await page.keyboard.press('ArrowRight')
  await checkApprovalNode(nodes.nth(approvalNodeIndex))
}

const checkCommittedState = async (
  page: Page,
  version: DemoVersion,
  status: 'approval' | 'completed',
): Promise<void> => {
  await page.getByRole('button', { name: /^State /u }).click()
  const state = page.getByLabel('Committed run state')
  await expect(state).toContainText(`"path": "${status}"`)
  await expect(state).toContainText(`"version": "${version}"`)
}

const findRun = (page: Page, runLabel: string): Locator =>
  persistedRuns(page).getByRole('button').filter({ hasText: runLabel })

const resumePersistedCheckpoint = async (page: Page, runLabel: string, version: DemoVersion): Promise<void> => {
  // Reloading leaves the checkpoint waiting for an explicit resume.
  await page.reload()
  await findRun(page, runLabel).click()
  await expect(continuation(page, version)).toBeVisible()
  await checkCommittedState(page, version, 'approval')
  await resumeButton(page).click()
  await expect(resumeButton(page)).toHaveCount(noMatches)
  await expect(page.getByRole('status')).toContainText('completed')
}

const checkCompletedRun = async (page: Page, runLabel: string, version: DemoVersion): Promise<void> => {
  // Re-open the same run by its rendered persisted identifier.
  await page.reload()
  const run = findRun(page, runLabel)
  await expect(run.getByText('completed', { exact: true })).toBeVisible()
  await run.click()
  await expect(workflowGraph(page).getByRole('button').last()).toHaveAttribute('data-state', 'succeeded')
  await checkCommittedState(page, version, 'completed')
  await page.getByRole('button', { name: /^Events /u }).click()
  const events = page.getByRole('region', { name: 'Persisted events' })
  await expect(events.getByText('run completed', { exact: true })).toBeVisible()
}

Array.forEach(demoVersions, (version) => {
  test(`${version} persists its checkpoint and resumes through the real Worker bindings`, async ({ page }, info) => {
    const errors = reportPageErrors(page)
    const runLabel = await startAndWait(page, version)
    await checkGraphKeyboard(page)
    await checkCommittedState(page, version, 'approval')
    await recordLayout(page, info, `${version}-waiting.png`)
    await resumePersistedCheckpoint(page, runLabel, version)
    await checkCompletedRun(page, runLabel, version)
    await recordLayout(page, info, `${version}-completed.png`)
    expect(errors, 'The browser must not have uncaught page errors').toEqual([])
  })
})
