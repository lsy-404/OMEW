import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// local full-stack QA: `wrangler dev` (server/) serves the real API on 8787,
// this dev server proxies the same route prefixes the production worker's
// run_worker_first list claims (server/wrangler.jsonc) so the SPA never
// needs to know it's talking to a separate port. If the dev server and
// wrangler dev aren't reachable from each other on the same origin, set
// VITE_API_BASE (see api/client.ts) to talk to the backend directly instead.
const BACKEND = 'http://127.0.0.1:8787'

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true },
      '/federation': { target: BACKEND, changeOrigin: true },
      '/.well-known/openmew': { target: BACKEND, changeOrigin: true },
      '/migration': { target: BACKEND, changeOrigin: true },
      '/rooms': { target: BACKEND, changeOrigin: true },
      '/inbox': { target: BACKEND, changeOrigin: true },
      '/media': { target: BACKEND, changeOrigin: true },
      '/stronghold': { target: BACKEND, changeOrigin: true, ws: true },
    },
  },
})
