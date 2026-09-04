import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  // Load VITE_* from the gitignored repo-root .env (not apps/concierge-web).
  envDir: repoRoot,
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/health': 'http://127.0.0.1:3000',
      '/webhooks': 'http://127.0.0.1:3000',
      '/.well-known': 'http://127.0.0.1:3000',
      '/mcp': 'http://127.0.0.1:3000',
      '/robots.txt': 'http://127.0.0.1:3000',
      '/sitemap.xml': 'http://127.0.0.1:3000',
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react/jsx-runtime'],
          router: ['react-router', 'react-router/dom'],
          supabase: ['@supabase/supabase-js'],
        },
      },
    },
  },
  test: {
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
  },
});
