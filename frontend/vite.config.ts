import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const frontendRoot = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    {
      name: 'omit-identity-review-data',
      apply: 'build',
      closeBundle() {
        if (mode !== 'production') return
        fs.rmSync(path.join(frontendRoot, 'dist', 'identity-review.json'), { force: true })
      }
    }
  ],
  resolve: {
    alias: {
      '@shared': path.join(repoRoot, 'shared')
    }
  },
  server: {
    port: 5173,
    strictPort: false,
    fs: {
      allow: [frontendRoot, repoRoot]
    },
    proxy: {
      '/api/identity-review': {
        target: 'http://localhost:3000',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'dist',
    sourcemap: mode !== 'production'
  }
}))
