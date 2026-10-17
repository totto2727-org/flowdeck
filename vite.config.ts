import { effrontAlchemy } from '@effront/alchemy/cloudflare/vite'
import { effrontTailwind } from '@effront/tailwind'
import { effront } from '@effront/vite'
import { generateIgnorePatterns } from '@totto2727/gitignore-patterns'
import { Array } from 'effect'
import { defineConfig } from 'vite-plus'

const ignorePatterns = await generateIgnorePatterns(new URL('.', import.meta.url))

export default defineConfig({
  resolve: { tsconfigPaths: true },
  // Effront client references and route providers must share the same module context.
  optimizeDeps: { exclude: ['@effront/core'] },
  plugins: [
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
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts', 'containers/jcode/**/*.test.ts'],
    testTimeout: 30_000,
  },
  run: {
    tasks: {
      'build:container': 'vp build --config containers/jcode/vite.config.ts',
      dev: {
        command: 'alchemy dev --config alchemy.run.ts --no-input',
        dependsOn: ['build:container'],
        cache: false,
      },
      check: 'vp check',
      fix: 'vp check --fix',
      test: 'vp test run',
      e2e: {
        command: 'playwright test --config tests/e2e/playwright.config.ts',
        dependsOn: ['build:container'],
      },
      ci: { command: '', dependsOn: ['check', 'test'] },
    },
  },
})
