import { getWorkspace } from '@cloudflare/computer'
import { createRegistry, Harness } from '@earendil-works/pi-durable'
import { PiHarness } from 'agents/harness/pi'

import type { ContainerEnvironment } from './container-host.ts'
import type { ContainerSdkHost } from './container-sdk-host.ts'
import { makePiModels } from './models.ts'
import { createWorkspaceTools } from './workspace.ts'

export const makeContainerHarness = (
  host: ContainerSdkHost,
  env: ContainerEnvironment,
): { harness: PiHarness; modelId: string } => {
  const { model, models } = makePiModels({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    apiKey: env.CLOUDFLARE_AI_GATEWAY_API_KEY,
    gatewayId: env.CLOUDFLARE_AI_GATEWAY_ID,
  })
  const harness = new PiHarness({
    defaults: { model },
    harness: async ({ context, storage }) => {
      // WorkspaceStub is a Capnweb target and stays in the same isolate as PiHarness.
      const workspace = await getWorkspace(host)
      const registry = createRegistry()
      registry.install({ name: 'workspace', tools: createWorkspaceTools(workspace) })
      return Harness.open(storage, { models, registry }, context)
    },
  })
  return { harness, modelId: model.id }
}
