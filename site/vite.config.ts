import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const here = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root: here,
  plugins: [react()],
  /* Dev only: the landing and dashboard call /api on their own origin, which
     in production is the Worker sitting in front of these same assets.

     Every Worker-owned path has to be listed, not just /api/. When only
     `^/api/` was proxied, POST /signup fell through to Vite's SPA fallback and
     came back as index.html with a 200 on it — so signup "succeeded" locally
     with an undefined token, and the whole setup flow could not be walked on
     localhost at all. The list below is exactly the Worker's non-/api routes
     that the site itself calls. */
  server: {
    port: 5174,
    proxy: {
      '^/(api/|signup$|me$|config$|health$|geocoach\\.(user|body)\\.js$)': {
        target: 'https://geofsrs.pages.dev',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../dist-site',
    emptyOutDir: true,
  },
})
