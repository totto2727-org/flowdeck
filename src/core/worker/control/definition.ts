import { Worker, type WorkerServices } from 'alchemy/Cloudflare/Workers'
import type { HttpEffect } from 'alchemy/Http'
import type { RuntimeContext } from 'alchemy/RuntimeContext'

/** Lightweight identity shared by the control implementation and static bindings. */
export class Control extends Worker<Control, { readonly fetch: HttpEffect<WorkerServices | RuntimeContext> }>()(
  'Control',
) {}
