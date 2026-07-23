import { defineConfig } from 'vite';
import pkg from '../../package.json' with { type: 'json' };

const BUILD_DATE = JSON.stringify(new Date().toISOString().slice(0, 19).replace('T', ' '));
const BUILD_VER = JSON.stringify(`v${pkg.version}`);

export default defineConfig({
  define: {
    __BUILD_VER__: BUILD_VER,
    __BUILD_DATE__: BUILD_DATE,
  },
  server: {
    port: 5173,
    // El backend de dev es el MISMO worker de Cloudflare que desplegamos
    // (wrangler dev en :8787, vía `pnpm dev` o `pnpm cf:dev`). El server Node
    // se eliminó del repo: solo Cloudflare.
    proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true },
      '/api': { target: 'http://localhost:8787' },
    },
  },
  build: {
    target: 'es2020',
    sourcemap: true,
  },
});
