import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const viteURL = 'http://127.0.0.1:5173';

export default defineConfig({
  testDir: '.',
  fullyParallel: true,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? viteURL,
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'pnpm dev',
    cwd: packageRoot,
    url: viteURL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
