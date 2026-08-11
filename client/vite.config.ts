import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const SERVER_PORT = Number(process.env.WD_PORT || 7070);
const SERVER_ORIGIN = `http://127.0.0.1:${SERVER_PORT}`;

// The release build passes WD_VERSION so the shell names the same build the
// server does, sha and all. Without it this is a source tree, and saying so is
// more honest than printing a bare number that only says which release is being
// worked towards.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};
const VERSION = process.env.WD_VERSION || `${pkg.version}+dev`;

export default defineConfig({
  define: {
    __FINESTRA_VERSION__: JSON.stringify(VERSION),
  },
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
