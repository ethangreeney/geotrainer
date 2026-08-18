import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const here = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root: here,
  plugins: [react()],
  /* Dev only: the landing and dashboard call /api on their own origin, which
     in production is the Worker sitting in front of these same assets. */
  server: {
    port: 5174,
    proxy: { '^/api/': { target: 'https://geofsrs.pages.dev', changeOrigin: true } },
  },
  build: {
    outDir: '../dist-site',
    emptyOutDir: true,
  },
})
