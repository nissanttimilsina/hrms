import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwind()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:4000', '/health': 'http://localhost:4000' } },
  build: { sourcemap: false, target: 'es2020' },
});
