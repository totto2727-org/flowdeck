import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: '*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  outputDir: '../../tmp/acceptance/test-results',
  reporter: [['list'], ['html', { outputFolder: 'tmp/acceptance/report', open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4380',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    // The e2e task builds the image input first. Playwright owns the native host lifecycle.
    command: 'alchemy dev --config alchemy.run.ts --no-input',
    cwd: '../..',
    url: 'http://127.0.0.1:4380',
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
