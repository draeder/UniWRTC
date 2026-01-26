import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  resolve: {
    alias: {
      buffer: 'buffer',
      events: 'events'
    }
  },
  optimizeDeps: {
    include: ['bittorrent-tracker', 'simple-peer', 'buffer', 'events']
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
