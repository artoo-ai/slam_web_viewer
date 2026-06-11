import { useEffect, useState } from 'react'
import { connection } from '../../lib/transport/connection'
import { useConnectionStore } from '../../stores/connectionStore'
import { PanelShell } from './PanelShell'

/** D435 color feed — plain <img> on the bridge's MJPEG stream. The URL is
 *  derived from the WebSocket host (port 8080), overridable via ?cam=. */

function resolveStreamUrl(): string {
  const fromQuery = new URLSearchParams(window.location.search).get('cam')
  if (fromQuery) return fromQuery
  const host = new URL(connection.url.replace(/^ws/, 'http')).hostname
  return `http://${host}:8080/stream/rgb`
}

export function CameraPanel() {
  const status = useConnectionStore((s) => s.status)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  // retry when the bridge reconnects or after a failure (10 s backoff)
  useEffect(() => {
    if (status === 'open' && failed) {
      const t = setTimeout(() => {
        setFailed(false)
        setAttempt((a) => a + 1)
      }, 10_000)
      return () => clearTimeout(t)
    }
  }, [status, failed])

  const url = resolveStreamUrl()
  return (
    <PanelShell title="Camera">
      {failed || status !== 'open' ? (
        <div className="camera-offline">
          no stream at {url}
          {status === 'open' && <span> — retrying…</span>}
        </div>
      ) : (
        <img
          key={attempt}
          className="camera-img"
          src={url}
          alt="robot camera"
          onError={() => setFailed(true)}
        />
      )}
    </PanelShell>
  )
}
