import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vite-plus/test'

import { Dashboard } from './dashboard'

vi.mock('./server', () => ({
  loadDashboard: vi.fn(),
  resumeRun: vi.fn(),
  selectRun: vi.fn(),
  startRun: vi.fn(),
}))

describe('workflow launch catalog', () => {
  it('selects the first advertised version and renders workflow-owned input descriptors', () => {
    const html = renderToStaticMarkup(
      createElement(Dashboard, {
        initial: {
          workflows: [
            {
              workflowId: 'publishing',
              name: 'Publishing',
              versions: ['3.2.1', '2.0.0'],
              inputs: [
                { name: 'title', label: 'Article title', kind: 'text', required: true, maxLength: 80 },
                {
                  name: 'body',
                  label: 'Article body',
                  kind: 'textarea',
                  required: false,
                  placeholder: 'Draft',
                  maxLength: 4000,
                },
              ],
            },
          ],
          runs: [],
          selected: null,
        },
      }),
    )

    expect(html).toContain('<option value="3.2.1" selected="">3.2.1</option>')
    expect(html).toContain('data-has-inputs="true"')
    expect(html).toContain('<option value="2.0.0">2.0.0</option>')
    expect(html).toContain('<label for="title">Article title</label>')
    expect(html).toContain('id="title" type="text" maxLength="80" required=""')
    expect(html).toContain('<textarea id="body" name="body" placeholder="Draft"')
  })

  it('renders a workflow with an explicitly empty input catalog without an input layout', () => {
    const html = renderToStaticMarkup(
      createElement(Dashboard, {
        initial: {
          workflows: [{ workflowId: 'publishing', name: 'Publishing', versions: ['3.2.1'], inputs: [] }],
          runs: [],
          selected: null,
        },
      }),
    )

    expect(html).toContain('<option value="3.2.1" selected="">3.2.1</option>')
    expect(html).toContain('data-has-inputs="false"')
    expect(html).not.toContain('<textarea')
  })

  it('renders an empty catalog without inventing a version or inputs', () => {
    const html = renderToStaticMarkup(
      createElement(Dashboard, { initial: { workflows: [], runs: [], selected: null } }),
    )

    expect(html).toContain('No workflow registered')
    expect(html).not.toContain('<option')
    expect(html).not.toContain('<textarea')
  })
})
