/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // Read the shared root .env (only the API URL is used here, never secrets).
  const env = loadEnv(mode, '../../', '');
  const apiUrl = env.API_PUBLIC_URL || 'http://localhost:4000';

  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      strictPort: true,
      // The browser calls /api/... on the dashboard's own origin; Vite forwards to the API.
      proxy: {
        '/api': { target: apiUrl, changeOrigin: true, rewrite: (path) => path.replace(/^\/api/, '') },
      },
    },
    test: { environment: 'node', include: ['src/**/*.test.ts'] },
  };
});
