import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), basicSsl()],
  server: {
    host: true, // expose on the LAN so the Quest browser can reach it
    proxy: {
      // TLS-terminating bridge proxy: an HTTPS page (Quest headset) can't open a
      // plain ws:// to the mock (mixed content), so it connects to same-origin
      // wss://<host>/bridge and Vite forwards it to the local ws bridge.
      '/bridge': {
        target: 'ws://localhost:9090',
        ws: true,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/bridge/, ''),
      },
    },
  },
})
