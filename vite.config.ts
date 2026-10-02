import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

// `npm run dev` serves the UI with hot reload and proxies to a running ridealong
const target = `http://127.0.0.1:${process.env.RIDEALONG_PORT || 8083}`;

export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'web/src'), '@shared': path.resolve(import.meta.dirname, 'shared') } },
  build: { outDir: '../dist/web', emptyOutDir: true, chunkSizeWarningLimit: 800 },
  server: {
    proxy: {
      '/api': target, '/login': target, '/logout': target,
      '/ws': { target: target.replace('http', 'ws'), ws: true },
    },
  },
});
