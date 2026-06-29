import { defineConfig, type PluginOption } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { createProxyServer } from 'http-proxy-3'
import type { Duplex } from 'node:stream'

// The local bridge the /bridge path forwards to; override to point dev at a
// remote robot, e.g. BRIDGE_WS=ws://gizmo.local:9090 npm run dev
const BRIDGE_TARGET = process.env.BRIDGE_WS ?? 'ws://localhost:9090'

// The robot's MJPEG camera server (:8080). Defaults to the bridge host so a
// single BRIDGE_WS=ws://<robot>:9090 also routes the camera; override with
// CAMERA_HTTP=http://<host>:8080 if it lives elsewhere.
const CAMERA_TARGET =
  process.env.CAMERA_HTTP ?? `http://${new URL(BRIDGE_TARGET).hostname}:8080`

/** Proxies the same-origin `wss://<host>/bridge` path to the local `ws` bridge so
 *  an HTTPS page (the Quest headset) can reach it without a mixed-content block.
 *
 *  We own this instead of using Vite's `server.proxy` because Vite's built-in
 *  proxy logs a full stack trace on every upstream failure: when the bridge is
 *  stopped, the browser's auto-reconnect would spam the terminal with
 *  `ECONNREFUSED` traces, and the half-open sockets stall Ctrl-C. Here a refused
 *  upstream just quietly closes the client socket, and live sockets are destroyed
 *  on shutdown so the dev server exits promptly. */
function bridgeWsProxy(): PluginOption {
  return {
    name: 'bridge-ws-proxy',
    configureServer(server) {
      const proxy = createProxyServer({ target: BRIDGE_TARGET, ws: true })
      const sockets = new Set<Duplex>()

      // Bridge down → quietly drop the client socket (no stack-trace spam). For a
      // ws upgrade, the third arg http-proxy emits is the client socket.
      proxy.on('error', (_err, _req, socket) => {
        try {
          ;(socket as Duplex | undefined)?.destroy()
        } catch {
          /* socket already gone */
        }
      })

      server.httpServer?.on('upgrade', (req, socket, head) => {
        if (!req.url?.startsWith('/bridge')) return // leave HMR + other upgrades to Vite
        req.url = req.url.replace(/^\/bridge/, '') || '/'
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
        proxy.ws(req, socket, head)
      })

      // Tear down any live proxied sockets on shutdown so Ctrl-C exits promptly.
      server.httpServer?.on('close', () => {
        for (const s of sockets) s.destroy()
        proxy.close()
      })
    },
  }
}

/** Proxies the same-origin `/camera/*` path to the robot's MJPEG server (:8080)
 *  so the HTTPS Quest page can show the camera feed without a mixed-content
 *  block. Same quiet-error rationale as the bridge proxy: a missing/refused
 *  camera just ends the response instead of spamming the terminal. */
function cameraHttpProxy(): PluginOption {
  return {
    name: 'camera-http-proxy',
    configureServer(server) {
      const proxy = createProxyServer({ target: CAMERA_TARGET })
      proxy.on('error', (_err, _req, res) => {
        try {
          const r = res as import('node:http').ServerResponse | undefined
          if (r && !r.headersSent) r.writeHead(502)
          r?.end()
        } catch {
          /* response already gone */
        }
      })
      server.middlewares.use('/camera', (req, res) => {
        req.url = req.url?.replace(/^\/camera/, '') || '/'
        proxy.web(req, res)
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), basicSsl(), bridgeWsProxy(), cameraHttpProxy()],
  server: {
    host: true, // expose on the LAN so the Quest browser can reach it
  },
})
