import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const adminRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: adminRoot,
  base: '/cms/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
