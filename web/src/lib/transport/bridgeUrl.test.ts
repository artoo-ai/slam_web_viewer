import { describe, expect, it } from 'vitest'
import { pickBridgeUrl } from './bridgeUrl'

describe('pickBridgeUrl', () => {
  const base = { queryWs: null, envUrl: undefined, protocol: 'http:', host: 'localhost:5173' }

  it('defaults to the local mock on a plain-http page', () => {
    expect(pickBridgeUrl(base)).toBe('ws://localhost:9090')
  })

  it('targets the same-origin wss /bridge proxy on an https page', () => {
    expect(pickBridgeUrl({ ...base, protocol: 'https:', host: '192.168.1.16:5173' }))
      .toBe('wss://192.168.1.16:5173/bridge')
  })

  it('lets VITE_BRIDGE_URL override the derived default', () => {
    expect(pickBridgeUrl({ ...base, protocol: 'https:', host: 'x', envUrl: 'ws://10.0.0.5:9090' }))
      .toBe('ws://10.0.0.5:9090')
  })

  it('lets the ?ws= query param win over everything', () => {
    expect(pickBridgeUrl({ queryWs: 'wss://custom/bridge', envUrl: 'ws://env:9090', protocol: 'https:', host: 'h' }))
      .toBe('wss://custom/bridge')
  })
})
