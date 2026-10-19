import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3737',
        changeOrigin: true,
      },
    },
  },
  preview: {
    // Production preview (also used by the Docker image): VITE_CORE_URL lets
    // the container point at the Compose service name (http://core:3737).
    proxy: {
      '/api': {
        target: process.env.VITE_CORE_URL || 'http://127.0.0.1:3737',
        changeOrigin: true,
      },
    },
  },
});
