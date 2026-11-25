import { defineConfig, devices } from '@playwright/test'

// oxlint-disable-next-line import/no-default-export -- Playwright loads the default configuration export.
export default defineConfig({
  fullyParallel: false,
  outputDir: '../../tmp/acceptance/test-results',
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { height: 1000, width: 1440 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'tmp/acceptance/report' }]],
  testDir: '.',
  testMatch: '*.e2e.ts',
  timeout: 90_000,
  use: {
    baseURL: 'http://127.0.0.1:4380',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    // Playwright owns the native host lifecycle.
    command: 'vp run dev',
    cwd: '../..',
    reuseExistingServer: false,
    stderr: 'pipe',
    stdout: 'pipe',
    timeout: 180_000,
    url: 'http://127.0.0.1:4380',
  },
  workers: 1,
})
