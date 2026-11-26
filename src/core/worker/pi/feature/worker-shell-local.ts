import { ShellWorker } from '@cloudflare/computer/backends/worker-shell'

// oxlint-disable-next-line unicorn/no-null -- The SDK's null sentinel disables shell fetch. An omitted value enables its default fetcher.
const disabledFetch = null

// The external-runtime connector runs the shell in the host isolate.
export class LocalShell extends ShellWorker {
  // oxlint-disable-next-line rules/no-readonly -- Match the native SDK's readonly shellOptions override.
  protected override readonly shellOptions = { fetch: disabledFetch }
}
