import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  publicDir: false,
  base: '/dist/',
  build: {
    outDir: 'public/dist',
    manifest: 'manifest.json',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    target: 'es2022',
    rollupOptions: {
      input: {
        app: 'src/client/main.js'
      }
    }
  }
});
