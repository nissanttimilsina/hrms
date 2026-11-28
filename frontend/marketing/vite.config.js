import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwind()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:4000', '/health': 'http://localhost:4000' } },
  // Preview (used by the UI check in CI): the public API answers on the marketing host.
  preview: { port: 4176, proxy: { '/api': { target: 'http://localhost:4000', headers: { host: process.env.VITE_MARKETING_HOST || 'www.hrms.localhost' } } } },
  build: { sourcemap: false, target: 'es2020' },
});
