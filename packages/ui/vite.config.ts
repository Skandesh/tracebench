import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@tracebench/core/context-analyzer': resolve(
        __dirname,
        '../core/dist/context-analyzer.js',
      ),
      '@tracebench/core/schema': resolve(__dirname, '../core/dist/schema.js'),
      '@tracebench/core/pricing': resolve(__dirname, '../core/dist/pricing-calc.js'),
      '@tracebench/core/pricing.json': resolve(__dirname, '../core/pricing.json'),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3478',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
