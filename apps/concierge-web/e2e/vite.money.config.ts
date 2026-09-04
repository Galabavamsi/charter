import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const api = 'http://127.0.0.1:3010';

export default defineConfig({
  root: packageRoot,
  envDir: repoRoot,
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
    proxy: {
      '/api': api,
      '/health': api,
      '/webhooks': api,
      '/.well-known': api,
    },
  },
});
