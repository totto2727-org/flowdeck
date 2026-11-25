import { Array, Effect, Layer } from 'effect'

import { ControlApi } from './control-api.ts'
import { Dashboard } from './dashboard.tsx'
import { EFFRONT } from './effront.ts'
import type { DashboardData } from './server.ts'
import { themeBootstrap } from './theme.ts'
import { presentRun, presentWorkflow } from './view-model.ts'

// oxlint-disable-next-line import/no-unassigned-import -- Vite extracts the dashboard stylesheet from this application entry.
import './styles/app.css'

const themeScript = { __html: themeBootstrap }

const layout = EFFRONT.Layout.make({
  render: ({ children }) =>
    Effect.succeed(
      <html
        lang='en'
        className='dark bg-background font-sans text-[14px] leading-normal text-foreground antialiased [font-synthesis:none] [text-rendering:optimizeLegibility] [&_button:not(:disabled)]:cursor-pointer [&_select:not(:disabled)]:cursor-pointer [&_summary]:cursor-pointer [&_button:disabled]:cursor-wait [&_:is(button,a,select,summary,input)]:[-webkit-tap-highlight-color:transparent] [&_:focus-visible]:outline-[3px] [&_:focus-visible]:outline-offset-[4px] [&_:focus-visible]:outline-[#178168] dark:[&_:focus-visible]:outline-primary motion-reduce:[&_*]:animate-none! motion-reduce:[&_*]:transition-none! motion-reduce:[&_*]:scroll-auto! motion-reduce:[&_*::before]:animate-none! motion-reduce:[&_*::after]:animate-none! motion-reduce:[&_*::before]:transition-none! motion-reduce:[&_*::after]:transition-none!'
        data-theme='dark'
        suppressHydrationWarning
      >
        <head>
          <meta charSet='utf-8' />
          <meta name='viewport' content='width=device-width,initial-scale=1' />
          <meta name='description' content='Flowdeck workflow execution, graphs, committed state and events.' />
          <meta name='theme-color' content='#101714' suppressHydrationWarning />
          {/* oxlint-disable-next-line rules/no-jsx-script-tag, react/no-danger -- This static script uses no request data and sets the theme before the first paint. */}
          <script dangerouslySetInnerHTML={themeScript} />
          <title>Overview · Flowdeck</title>
        </head>
        <body>{children}</body>
      </html>,
    ),
})

// oxlint-disable-next-line unicorn/no-null -- The dashboard uses the Server Function's encoded unselected state.
const noSelection = null

const loadOverview = Effect.gen(function* () {
  const api = yield* ControlApi
  const [workflows, runs] = yield* Effect.all([api.workflows, api.runs], { concurrency: 2 })
  return {
    runs: Array.map(runs.runs, (run) => presentRun(run)),
    selected: noSelection,
    workflows: Array.map(workflows.workflows, (workflow) => presentWorkflow(workflow)),
  } satisfies DashboardData
})

const renderOverview = Effect.fn('Flowdeck.overview')(function* () {
  const initial = yield* loadOverview
  return <Dashboard initial={initial} />
})

const overview = EFFRONT.Page.make({
  render: () =>
    renderOverview().pipe(
      Effect.catchTag('ControlError', ({ message }) =>
        Effect.succeed(
          <main className='mx-auto my-[15vh] max-w-[600px] p-[30px]'>
            <h1 className='text-[30px] leading-[1.35] font-[650] tracking-[-1px] max-[620px]:text-[27px]'>
              Control plane unavailable
            </h1>
            <p className='my-[18px]' role='alert'>
              {message}
            </p>
            <a className='text-primary underline' href='/'>
              Retry dashboard
            </a>
          </main>,
        ),
      ),
    ),
})

const application = EFFRONT.make({
  layer: Layer.effect(ControlApi, ControlApi),
  routes: EFFRONT.Routes.make({ layout }).page('/', overview),
})

// oxlint-disable-next-line import/no-default-export -- Effront discovers the application through the default entry export.
export default application
