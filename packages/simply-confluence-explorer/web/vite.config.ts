import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

// The frontend builds into dist/web/, which the Node server (src/server.ts) serves. In
// `pnpm run dev`, Vite serves it with HMR and forwards /api to that server. This file lives in web/
// rather than the package root so that vitest, run from the package root, never picks it up in
// place of the repo's vitest.config.ts.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [svelte()],
  build: {
    outDir: fileURLToPath(new URL('../dist/web/', import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:4280',
    },
  },
});
