import { effrontAlchemy } from '@effront/alchemy/cloudflare/vite'
import { effrontTailwind } from '@effront/tailwind'
import { effront } from '@effront/vite'
import { generateIgnorePatterns } from '@totto2727/gitignore-patterns'
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
    ignorePatterns,
  },
  lint: {
    ignorePatterns,
    // Temporary: Vite+ 1.4.0's checker cannot load SQL Content Mappers (TS2307).
    // Remove this opt-out and check:tsc when vp check supports them.
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
      dev: {
        command: 'node --import reylo/register node_modules/alchemy/bin/cli.js dev --config alchemy.run.ts --no-input',
        cache: false,
      },
      // Temporary: remove this task when vp check supports SQL Content Mappers.
      'check:tsc': { command: 'tsc --noEmit --runExternalCode' },
      'check:atlas': { command: 'atlas schema validate --env schema' },
      'check:vp': { command: 'vp check' },
      check: { command: '', dependsOn: ['check:vp', 'check:tsc', 'check:atlas'] },
      'fix:atlas': { command: 'atlas schema fmt atlas.hcl schema' },
      'fix:vp': { command: 'vp check --fix' },
      fix: { command: '', dependsOn: ['fix:vp', 'fix:atlas'] },
      test: { command: 'vp test run' },
      e2e: {
        command: 'playwright test --config tests/e2e/playwright.config.ts',
      },
      ci: { command: '', dependsOn: ['check', 'test'] },
    },
  },
})
