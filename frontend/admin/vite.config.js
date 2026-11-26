import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

// Dev: the API resolves the platform host from the Host header; ADMIN_HOST in backend .env must match.
export default defineConfig({
  plugins: [react(), tailwind()],
  server: { port: 5174, proxy: { '/api': { target: 'http://localhost:4000', headers: { host: 'admin.hrms.localhost' } } } },
  preview: { port: 4174, proxy: { '/api': { target: 'http://localhost:4000', headers: { host: 'admin.hrms.localhost' } } } },
  build: { target: 'es2020', chunkSizeWarningLimit: 900 },
});
