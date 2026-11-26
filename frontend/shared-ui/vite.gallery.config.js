import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

// Component gallery (visual QA of the design system).
export default defineConfig({
  root: 'gallery',
  base: './',
  plugins: [react(), tailwind()],
  build: { outDir: '../dist-gallery', emptyOutDir: true },
});
