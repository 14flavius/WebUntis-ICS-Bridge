import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
export default defineConfig({
  plugins: [react(), tailwind()],
  build: { outDir: 'dist/web' },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '^/feed/': 'http://127.0.0.1:3000',
    },
  },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
