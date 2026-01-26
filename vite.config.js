import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  resolve: {
    alias: {
      buffer: 'buffer',
      events: 'events',
      process: 'process/browser'
    }
  },
  optimizeDeps: {
    include: ['bittorrent-tracker', 'simple-peer', 'buffer', 'events', 'process']
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: './index.html'
      }
    }
  }
});
