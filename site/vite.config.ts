import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const here = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root: here,
  plugins: [react()],
  build: {
    outDir: '../dist-site',
    emptyOutDir: true,
  },
})
