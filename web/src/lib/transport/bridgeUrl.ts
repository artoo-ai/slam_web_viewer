/** Decide which bridge WebSocket URL to connect to.
 *  Priority: explicit ?ws= override → VITE_BRIDGE_URL → derived default.
 *  On an HTTPS page (Quest headset / secure dev) a plain ws:// to a remote host
 *  is blocked by the browser as mixed content, so we target the same-origin
 *  wss:// `/bridge` path that the Vite dev server proxies to the local mock.
 *  On a plain-http page we hit the local mock directly. */
export interface BridgeUrlContext {
  /** value of the ?ws= query param, or null */
  queryWs: string | null
  /** import.meta.env.VITE_BRIDGE_URL, or undefined */
  envUrl: string | undefined
  /** window.location.protocol, e.g. 'https:' */
  protocol: string
  /** window.location.host, e.g. '192.168.1.16:5173' */
  host: string
}

export function pickBridgeUrl(ctx: BridgeUrlContext): string {
  if (ctx.queryWs) return ctx.queryWs
  if (ctx.envUrl) return ctx.envUrl
  if (ctx.protocol === 'https:') return `wss://${ctx.host}/bridge`
  return 'ws://localhost:9090'
}
