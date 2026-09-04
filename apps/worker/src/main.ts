import { loadConfig } from '@charter/config';

const config = loadConfig();
console.log(
  JSON.stringify({
    ok: true,
    service: 'worker',
    env: config.CHARTER_ENV,
    role: process.env.WORKER_ROLE ?? 'all',
  }),
);
