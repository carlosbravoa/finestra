import { defineConfig } from 'vite';

const SERVER_PORT = Number(process.env.WD_PORT || 7070);
const SERVER_ORIGIN = `http://127.0.0.1:${SERVER_PORT}`;

export default defineConfig({
  server: {
    port: Number(process.env.WD_CLIENT_PORT || 5173),
    // The dev server proxies the API and socket, so the client sees one origin
    // in development and in production alike.
    proxy: {
      '/api': { target: SERVER_ORIGIN, changeOrigin: true },
      '/healthz': { target: SERVER_ORIGIN, changeOrigin: true },
      '/ws': { target: SERVER_ORIGIN, ws: true, changeOrigin: true },
    },
    fs: {
      // `shared/protocol.ts` lives above the client package root.
      allow: ['..'],
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 900,
  },
});
