import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Library build consumed by marketing / super-admin / company-app.
export default defineConfig({
  plugins: [react()],
  build: {
    lib: { entry: 'src/index.js', formats: ['es'], fileName: 'index' },
    rollupOptions: { external: ['react', 'react-dom', 'react/jsx-runtime', 'clsx'] },
    sourcemap: true,
  },
});
