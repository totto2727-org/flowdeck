import { effrontAlchemy } from '@effront/alchemy/cloudflare/vite'
import { effrontTailwind } from '@effront/tailwind'
import { effront } from '@effront/vite'
import { defineConfig } from 'vite-plus'

export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    effront({ application: './src/web/entry.effront.tsx' }),
    effrontAlchemy({ worker: './alchemy.ts' }),
    ...effrontTailwind({ stylesheet: './src/web/styles/app.css' }),
  ],
  environments: { ssr: { build: { rolldownOptions: { platform: 'neutral' } } } },
  fmt: {
    arrowParens: 'always',
    experimentalSortImports: { ignoreCase: true, newlinesBetween: true, order: 'asc' },
    experimentalSortPackageJson: true,
    jsxSingleQuote: true,
    printWidth: 120,
    proseWrap: 'preserve',
    semi: false,
    singleQuote: true,
    ignorePatterns: ['legacy/**', 'tmp/**', 'pnpm-lock.yaml'],
  },
  lint: {
    ignorePatterns: ['legacy/**', 'tmp/**'],
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    projects: [
      {
        extends: false,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
          exclude: ['src/runtime/**/*.workers.test.ts'],
          testTimeout: 30_000,
        },
      },
    ],
  },
  run: {
    tasks: {
      dev: { command: 'alchemy dev --config alchemy.run.ts', cache: false },
      check: 'vp check',
      fix: 'vp check --fix',
      test: 'vp test run',
      ci: { command: '', dependsOn: ['check', 'test'] },
    },
  },
})
