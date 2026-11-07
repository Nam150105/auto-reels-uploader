import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'node:path';

export default defineConfig({
  plugins: [vue()],
  root: path.resolve(__dirname, 'src/frontend'),
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/frontend'),
      '@shared': path.resolve(__dirname, 'src/shared')
    }
  },
  build: {
    outDir: path.resolve(__dirname, 'static'),
    emptyOutDir: false,
    rollupOptions: {
      input: path.resolve(__dirname, 'src/frontend/index.html'),
      output: {
        entryFileNames: 'assets/app.[hash].js',
        chunkFileNames: 'assets/[name].[hash].js',
        assetFileNames: 'assets/[name].[hash].[ext]'
      }
    }
  }
});
