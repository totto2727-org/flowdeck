import { effrontAlchemy } from '@effront/alchemy/cloudflare/vite'
import { effrontTailwind } from '@effront/tailwind'
import { effront } from '@effront/vite'
import { generateIgnorePatterns } from '@totto2727/gitignore-patterns'
import oxlintPreset from '@totto2727/oxlint/preset/application'
import reylo from '@totto2727/reylo/vite'
import { defineConfig } from 'vite-plus'

const ignorePatterns = await generateIgnorePatterns(new URL('.', import.meta.url))

// Vite+ can use tsrs for type-aware lint and type checking. Permit the installed Reylo SQL Content Mapper.
const typeChecker = 'OXLINT_TSGOLINT_PATH=./node_modules/.bin/tsrs-lint TSRS_LINT_RUN_EXTERNAL_CODE=1'

// Keep the retained Rust implementation byte-for-byte unchanged until its separate removal PR.
const retainedRustFormatting = [
  '.agents/skills/develop-flowdeck-workflows/**',
  'DESIGN.md',
  'crates/graph-flow-jcode/docs/**',
  'docs/architecture.ja.md',
  'docs/history-sse-delta-plan.md',
  'docs/plans/application-config.md',
  'docs/plans/jcode-runtime-separation.md',
  'src/app.css',
]

// oxlint-disable-next-line import/no-default-export -- Vite loads the default configuration export.
export default defineConfig({
  fmt: {
    arrowParens: 'always',
    experimentalSortImports: { ignoreCase: true, newlinesBetween: true, order: 'asc' },
    experimentalSortPackageJson: true,
    ignorePatterns: [...ignorePatterns, ...retainedRustFormatting],
    jsxSingleQuote: true,
    printWidth: 120,
    proseWrap: 'preserve',
    semi: false,
    singleQuote: true,
  },
  lint: {
    extends: [oxlintPreset],
    ignorePatterns,
    options: { ...oxlintPreset.options, typeCheck: true },
    overrides: [
      { env: { worker: true }, files: ['src/**/*.{ts,tsx}', 'tests/**/*.{ts,tsx}'] },
      {
        env: { browser: true },
        files: [
          'src/core/worker/frontend/feature/**/*.{tsx,jsx}',
          'src/core/worker/frontend/feature/theme{,.test}.ts',
          'tests/e2e/**/*.{ts,tsx}',
        ],
      },
      { env: { node: true }, files: ['*.ts', '**/*.test.{ts,tsx}', 'tests/**/*.{ts,tsx}'] },
    ],
  },
  plugins: [
    reylo(),
    effront({ application: './src/core/worker/frontend/feature/entry.effront.tsx' }),
    effrontAlchemy({ worker: './src/core/worker/frontend/worker.ts' }),
    ...effrontTailwind({ stylesheet: './src/core/worker/frontend/feature/styles/app.css' }),
  ],
  resolve: { tsconfigPaths: true },
  run: {
    tasks: {
      'build:nix': {
        cache: false,
        command: 'docker build --target nix -t ghcr.io/totto2727-org/flowdeck/nix:latest -f sandbox/Dockerfile sandbox',
      },
      'build:sandbox': {
        cache: false,
        command:
          'docker build --target sandbox -t ghcr.io/totto2727-org/flowdeck/sandbox-base:latest -f sandbox/Dockerfile sandbox',
      },
      check: { command: '', dependsOn: ['check:vp', 'check:atlas'] },
      'check:atlas': { command: 'atlas schema validate --env schema' },
      'check:vp': { command: `${typeChecker} vp check` },
      ci: { command: '', dependsOn: ['check', 'test'] },
      dev: {
        cache: false,
        command:
          'node --import @totto2727/reylo/register node_modules/alchemy/bin/cli.js dev --config alchemy.run.ts --no-input',
      },
      e2e: {
        command: 'playwright test --config tests/e2e/playwright.config.ts',
      },
      fix: { command: '', dependsOn: ['fix:vp', 'fix:atlas'] },
      'fix:atlas': { command: 'atlas schema fmt atlas.hcl schema' },
      'fix:vp': { command: `${typeChecker} vp check --fix` },
      test: { command: 'vp test run' },
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    testTimeout: 30_000,
  },
})
