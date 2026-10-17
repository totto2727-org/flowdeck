import { Database as D1Database } from 'alchemy/Cloudflare/D1'

/** Shared canonical storage, owned by this local stack rather than a run object. */
export const Database = D1Database('Database', {
  name: 'flowdeck-local',
  migrations: './migrations',
})
