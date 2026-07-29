import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'src/renderer',
  base: './',
  define: {
    'import.meta.env.VITE_GROUND_BROWSER_PREVIEW': JSON.stringify('true')
  },
  resolve: {
    alias: {
      '@renderer': path.resolve('src/renderer/src'),
      '@shared': path.resolve('src/shared')
    }
  },
  plugins: [react()],
  build: {
    outDir: '../../preview-dist',
    emptyOutDir: true
  }
})
