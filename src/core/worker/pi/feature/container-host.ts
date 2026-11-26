/* oxlint-disable eslint/max-classes-per-file -- The Workspace mixin needs a concrete typed native Durable Object subclass to preserve its protected ctx. */
import type { WorkspaceOptions } from '@cloudflare/computer'
import { ContainerBackend, withWorkspaceContainer } from '@cloudflare/computer/backends/container'
import { DurableObject } from 'cloudflare:workers'
import { Schema } from 'effect'

import { CONTAINER_BACKEND } from './workspace.ts'

const Environment = Schema.Struct({
  CLOUDFLARE_ACCOUNT_ID: Schema.String,
  CLOUDFLARE_AI_GATEWAY_API_KEY: Schema.String,
  CLOUDFLARE_AI_GATEWAY_ID: Schema.String,
})

export type ContainerEnvironment = typeof Environment.Type
// oxlint-disable-next-line rules/prefer-non-unknown-decode -- The Worker binding record is untrusted until the required settings are validated.
export const decodeEnvironment = Schema.decodeUnknownEffect(Environment)

export class ContainerHost extends withWorkspaceContainer(class extends DurableObject<ContainerEnvironment> {}) {
  #backend = new ContainerBackend({
    container: () => this,
    egress: { mode: 'direct' },
    id: CONTAINER_BACKEND,
    instance: 'standard-1',
    name: 'JcodeSandbox',
    workspace: { binding: 'DevelopmentRun', id: this.ctx.id.toString() },
  })

  public get backend(): ContainerBackend {
    return this.#backend
  }

  public workspaceOptions(): WorkspaceOptions {
    return { backends: [this.backend], storage: this.ctx.storage }
  }
}
