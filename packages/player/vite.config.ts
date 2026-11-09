import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const target = process.env.SIGNAGE_SERVER ?? 'http://127.0.0.1:8080';

export default defineConfig({
  base: '/player/',
  resolve: {
    alias: {
      '@signage/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  define: {
    __BUILD__: JSON.stringify(new Date().toISOString().slice(0, 16)),
  },
  server: {
    port: 5174,
    proxy: {
      '/ws': { target, ws: true },
      '/api': target,
      '/media': target,
      '/content': target,
      '/thumbs': target,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        // Service Worker собирается отдельным файлом без хэша: /player/sw.js
        sw: fileURLToPath(new URL('./src/sw.ts', import.meta.url)),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
});
