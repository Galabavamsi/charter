import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts', 'src/postbuild-smoke-helpers.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: true,
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  noExternal: [/^@charter\//],
});
