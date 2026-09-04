import { defineConfig, devices } from '@playwright/test';

const liveOrigin =
  process.env.PLAYWRIGHT_BASE_URL ?? 'https://core-api-production-087b.up.railway.app';

/**
 * Origin smoke against the live same-origin evaluator.
 * Only evaluator.spec.ts: public/discovery/MCP, public a11y, directory→
 * storefront→auth return. No webServer, no login, no invented credentials.
 * Does not replace M7 live fail→retry.
 */
export default defineConfig({
  testDir: '.',
  testMatch: 'evaluator.spec.ts',
  fullyParallel: true,
  retries: 1,
  use: {
    baseURL: liveOrigin,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
