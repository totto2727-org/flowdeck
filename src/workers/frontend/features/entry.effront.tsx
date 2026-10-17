import { Effect, Layer } from 'effect'

import { ControlApi } from './control-api'
import { Dashboard } from './dashboard'
import { EFFRONT } from './effront'
import { themeBootstrap } from './theme'

import './styles/app.css'

const layout = EFFRONT.Layout.make({
  render: ({ children }) =>
    Effect.succeed(
      <html lang='en' className='dark' data-theme='dark' suppressHydrationWarning>
        <head>
          <meta charSet='UTF-8' />
          <meta name='viewport' content='width=device-width,initial-scale=1' />
          <meta name='description' content='Flowdeck workflow execution, graphs, committed state and events.' />
          <meta name='theme-color' content='#101714' suppressHydrationWarning />
          <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
          <title>Overview · Flowdeck</title>
        </head>
        <body>{children}</body>
      </html>,
    ),
})

const overview = EFFRONT.Page.make({
  render: Effect.fn('Flowdeck.overview')(function* () {
    const api = yield* ControlApi
    return yield* Effect.all([api.workflows, api.runs], { concurrency: 2 }).pipe(
      Effect.map(([workflows, runs]) => (
        <Dashboard initial={{ workflows: workflows.workflows, runs: runs.runs, selected: null }} />
      )),
      Effect.catchTag('ControlError', (error) =>
        Effect.succeed(
          <main className='startup-error'>
            <h1>Control plane unavailable</h1>
            <p role='alert'>{error.message}</p>
            <a href='/'>Retry dashboard</a>
          </main>,
        ),
      ),
    )
  }),
})

export default EFFRONT.make({
  layer: Layer.effect(ControlApi, ControlApi),
  routes: EFFRONT.Routes.make({ layout }).page('/', overview),
})
