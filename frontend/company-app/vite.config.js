import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

// Dev: proxy to the API with a tenant Host header (set VITE_DEV_TENANT_HOST, e.g. demo.hrms.localhost).
const host = process.env.VITE_DEV_TENANT_HOST || 'demo.hrms.localhost';
export default defineConfig({
  plugins: [react(), tailwind()],
  server: { port: 5175, proxy: { '/api': { target: 'http://localhost:4000', headers: { host } } } },
  preview: { port: 4175, proxy: { '/api': { target: 'http://localhost:4000', headers: { host } } } },
  build: { target: 'es2020', chunkSizeWarningLimit: 1000 },
});
