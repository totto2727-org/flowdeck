import { Effect, Layer } from 'effect'

import { ControlApi } from './control-api'
import { Dashboard } from './dashboard'
import { EFFRONT } from './effront'
import { themeBootstrap } from './theme'

import './styles/app.css'

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
          <main className='mx-auto my-[15vh] max-w-[600px] p-[30px]'>
            <h1 className='text-[30px] leading-[1.35] font-[650] tracking-[-1px] max-[620px]:text-[27px]'>
              Control plane unavailable
            </h1>
            <p className='my-[18px]' role='alert'>
              {error.message}
            </p>
            <a className='text-primary underline' href='/'>
              Retry dashboard
            </a>
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
