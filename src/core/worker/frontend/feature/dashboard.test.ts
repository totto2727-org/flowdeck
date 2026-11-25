import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vite-plus/test'

import { Dashboard } from './dashboard.tsx'
import type { DashboardData, loadDashboard, resumeRun, selectRun, startRun } from './server.ts'

// oxlint-disable-next-line vitest/prefer-import-in-mock -- Client tests substitute simple functions for the production server-function objects and their native metadata.
vi.mock('./server', () => ({
  loadDashboard: vi.fn<typeof loadDashboard>(),
  resumeRun: vi.fn<typeof resumeRun>(),
  selectRun: vi.fn<typeof selectRun>(),
  startRun: vi.fn<typeof startRun>(),
}))

// oxlint-disable-next-line unicorn/no-null -- A null selection matches the encoded dashboard data.
const noSelection = null
const workflow = { inputs: [], name: 'Publishing', versions: ['3.2.1'], workflowId: 'publishing' }
const withInputs = {
  ...workflow,
  inputs: [
    { kind: 'text', label: 'Article title', maxLength: 80, name: 'title', required: true },
    {
      kind: 'textarea',
      label: 'Article body',
      maxLength: 4000,
      name: 'body',
      placeholder: 'Draft',
      required: false,
    },
  ],
  versions: ['3.2.1', '2.0.0'],
} satisfies DashboardData['workflows'][number]

const renderCatalog = (workflows: DashboardData['workflows']): string => {
  const initial: DashboardData = { runs: [], selected: noSelection, workflows }
  return renderToStaticMarkup(createElement(Dashboard, { initial }))
}

describe('workflow launch catalog', () => {
  test('selects the first advertised version and renders workflow-owned input descriptors', () => {
    const html = renderCatalog([withInputs])
    const fragments = [
      '<option value="3.2.1" selected="">3.2.1</option>',
      'data-has-inputs="true"',
      '<option value="2.0.0">2.0.0</option>',
      '<label for="title">Article title</label>',
      'id="title" type="text" maxLength="80" required=""',
      '<textarea id="body" name="body" placeholder="Draft"',
    ]
    expect(fragments.filter((fragment) => !html.includes(fragment))).toStrictEqual([])
  })

  test('renders a workflow with an explicitly empty input catalog without an input layout', () => {
    const html = renderCatalog([workflow])

    expect(html).toContain('<option value="3.2.1" selected="">3.2.1</option>')
    expect(html).toContain('data-has-inputs="false"')
    expect(html).not.toContain('<textarea')
  })

  test('renders an empty catalog without inventing a version or inputs', () => {
    const html = renderCatalog([])

    expect(html).toContain('No workflow registered')
    expect(html).not.toContain('<option')
    expect(html).not.toContain('<textarea')
  })
})
