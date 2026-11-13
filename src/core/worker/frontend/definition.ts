import { Worker, type WorkerServices } from 'alchemy/Cloudflare/Workers'
import type { HttpEffect } from 'alchemy/Http'
import type { RuntimeContext } from 'alchemy/RuntimeContext'

/** Lightweight identity shared by the frontend implementation and static bindings. */
export class Frontend extends Worker<Frontend, { readonly fetch: HttpEffect<WorkerServices | RuntimeContext> }>()(
  'Frontend',
) {}
