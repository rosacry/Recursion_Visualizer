import path from 'path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  base: '/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // local native C++20 trace service (native/server.mjs)
      '/api/native': { target: `http://127.0.0.1:${process.env.RV_NATIVE_PORT || 5180}`, changeOrigin: false },
    },
  },
  preview: {
    proxy: {
      '/api/native': { target: `http://127.0.0.1:${process.env.RV_NATIVE_PORT || 5180}`, changeOrigin: false },
    },
  },
})
