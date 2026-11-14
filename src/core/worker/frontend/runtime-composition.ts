import { Layer } from 'effect'

import { RuntimeSecurity } from './access'
import FrontendLive from './frontend'

/**
 * The native Effront bridge imports a runtime-only entry, not the deployment graph.
 * Alchemy WorkerBridge supplies native bindings and makeEntrypointLayer;
 * Platform.make then reconstructs this Worker's handler against captured bindings.
 * Rebuilding the application here would initialize sibling Workers and redeclare
 * the deployment-only Access Application without deployment providers. Empty
 * resource props are therefore intentional: AUD and service bindings come from
 * the bridge's native WorkerEnvironment, decoded by request assembly adapters.
 * This fixed composition needs no runtime phase or development-mode decision.
 * See alchemy/src/Cloudflare/Workers/WorkerBridge.ts and alchemy/src/Platform.ts.
 */
export const FrontendRuntimeLayer = FrontendLive.pipe(Layer.provide(RuntimeSecurity))
