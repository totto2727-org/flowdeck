import type { Plugin } from 'vite-plus'

const ALCHEMY_ENTRY_PREFIX = '\0virtual:alchemy-entry:'
const WORKSPACE_PROXY_EXPORT = "export { WorkspaceProxy } from '@cloudflare/computer'"

/** Preserve the one SDK-native export required by Computer's Container backend. */
export const workspaceProxyBuild = (): Plugin => ({
  name: 'flowdeck:workspace-proxy',
  // Alchemy's official Effect virtual entry exports its generated Worker/DO
  // bridges only, so a named export in worker.ts does not reach the bundle.
  // Computer's WorkspaceContainerAPI calls ctx.exports.WorkspaceProxy when
  // configuring egress. This public build.input.plugins transform adds that
  // official native SDK class to the generated entry only. It does not replace
  // the Effect entrypoint, access props.exports, or reproduce the SDK runtime.
  // The public hook is stable, but this virtual-module prefix is a beta.83
  // implementation detail. The generated-entry/workerd regression detects drift.
  transform(code, id) {
    if (!id.startsWith(ALCHEMY_ENTRY_PREFIX) || code.includes(WORKSPACE_PROXY_EXPORT)) return null
    return { code: `${code}\n${WORKSPACE_PROXY_EXPORT}\n`, map: null }
  },
})
