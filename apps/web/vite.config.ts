import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  assetsInclude: ['**/*.wasm'],
  server: {
    port: 5173,
    fs: {
      allow: ['..'],
    },
    proxy: {
      '/api/overpass': {
        target: 'https://lz4.overpass-api.de/api/interpreter',
        changeOrigin: true,
        rewrite: () => '',
        headers: {
          'User-Agent': 'PathfinderApp/1.0 (https://github.com)',
        },
      },
    },
  },
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: ['@pathfinder/connector', '@pathfinder/visualizer'],
  },
});
