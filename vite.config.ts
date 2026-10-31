import { effrontAlchemy } from '@effront/alchemy/cloudflare/vite'
import { effrontTailwind } from '@effront/tailwind'
import { effront } from '@effront/vite'
import { generateIgnorePatterns } from '@totto2727/gitignore-patterns'
import { Array } from 'effect'
import reylo from 'reylo/vite'
import { defineConfig } from 'vite-plus'

const ignorePatterns = await generateIgnorePatterns(new URL('.', import.meta.url))

export default defineConfig({
  resolve: { tsconfigPaths: true },
  // Effront client references and route providers must share the same module context.
  optimizeDeps: { exclude: ['@effront/core'] },
  plugins: [
    reylo(),
    effront({ application: './src/workers/frontend/features/entry.effront.tsx' }),
    effrontAlchemy({ worker: './src/workers/frontend/worker.ts' }),
    ...effrontTailwind({ stylesheet: './src/workers/frontend/features/styles/app.css' }),
  ],
  fmt: {
    arrowParens: 'always',
    experimentalSortImports: { ignoreCase: true, newlinesBetween: true, order: 'asc' },
    experimentalSortPackageJson: true,
    jsxSingleQuote: true,
    printWidth: 120,
    proseWrap: 'preserve',
    semi: false,
    singleQuote: true,
    ignorePatterns: Array.append(ignorePatterns, 'pnpm-lock.yaml'),
  },
  lint: {
    ignorePatterns,
    // TypeScript 7.1 owns complete type checking, including SQL Content Mappers.
    // Vite+'s separate TS 7.0 backend still supplies type-aware lint rules.
    options: { typeAware: true, typeCheck: false },
  },
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    testTimeout: 30_000,
  },
  run: {
    tasks: {
      'build:nix': {
        command: 'docker build --target nix -t ghcr.io/totto2727-org/flowdeck/nix:latest -f sandbox/Dockerfile sandbox',
        cache: false,
      },
      'build:sandbox': {
        command:
          'docker build --target sandbox -t ghcr.io/totto2727-org/flowdeck/sandbox-base:latest -f sandbox/Dockerfile sandbox',
        cache: false,
      },
      'schema:prepare': {
        command:
          'mkdir -p .atlas && atlas schema apply --url sqlite://.atlas/schema.db --to file://schema/schema.hcl --dev-url "sqlite://dev?mode=memory" --auto-approve',
        cache: false,
      },
      'schema:check': {
        // Rebuild the inspected migration schema to normalize SQLite's implicit UNIQUE indexes
        // through Atlas itself. Do not exclude indexes or apply this normalization to runtime D1.
        command:
          'atlas migrate validate --dir file://migrations && mkdir -p .atlas && atlas schema inspect --url file://migrations --dev-url "sqlite://dev?mode=memory" --format "{{ hcl . }}" > .atlas/migrations.hcl && rm -f .atlas/migrations-normalized.db && atlas schema apply --url sqlite://.atlas/migrations-normalized.db --to file://.atlas/migrations.hcl --dev-url "sqlite://dev?mode=memory" --auto-approve && atlas schema diff --from sqlite://.atlas/migrations-normalized.db --to file://schema/schema.hcl --dev-url "sqlite://dev?mode=memory" --format "{{ sql . }}" > .atlas/drift.sql && (test ! -s .atlas/drift.sql || (cat .atlas/drift.sql && false))',
        cache: false,
      },
      typecheck: { command: 'tsc --noEmit --runExternalCode', dependsOn: ['schema:prepare', 'schema:check'] },
      dev: {
        command: 'node --import reylo/register node_modules/alchemy/bin/cli.js dev --config alchemy.run.ts --no-input',
        dependsOn: ['schema:prepare'],
        cache: false,
      },
      check: { command: 'vp check', dependsOn: ['typecheck'] },
      fix: 'vp check --fix',
      test: { command: 'vp test run', dependsOn: ['schema:prepare'] },
      e2e: {
        command: 'playwright test --config tests/e2e/playwright.config.ts',
        dependsOn: ['schema:prepare'],
      },
      ci: { command: '', dependsOn: ['check', 'test'] },
    },
  },
})
