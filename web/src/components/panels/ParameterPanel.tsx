import { useState } from 'react'
import { useViewerParams } from '../../stores/viewerParamsStore'
import { useSendCommand } from '../../hooks/useSendCommand'
import { PanelShell } from './PanelShell'
import type { ParamAck } from '../../types/channels'

/** Viewer params (local, instant) + remote set_param with ack badges. */

type AckState = { kind: 'ok' | 'rejected' | 'timeout'; text: string } | null

export function ParameterPanel() {
  const params = useViewerParams()
  const send = useSendCommand()
  const [node, setNode] = useState('slam_toolbox')
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [ack, setAck] = useState<AckState>(null)
  const [sending, setSending] = useState(false)

  const sendParam = async () => {
    if (!name.trim()) return
    const num = Number(value)
    const parsed: unknown =
      value.trim() === 'true' ? true :
      value.trim() === 'false' ? false :
      Number.isFinite(num) && value.trim() !== '' ? num : value
    setSending(true)
    setAck(null)
    const reply = (await send({
      cmd: 'set_param',
      node: node.trim(),
      params: { [name.trim()]: parsed },
    })) as ParamAck | null
    setSending(false)
    if (!reply) setAck({ kind: 'timeout', text: 'no reply from bridge' })
    else if (Object.keys(reply.accepted ?? {}).length > 0)
      setAck({ kind: 'ok', text: `accepted: ${name.trim()}` })
    else setAck({ kind: 'rejected', text: `rejected: ${name.trim()}` })
  }

  return (
    <PanelShell title="Parameters">
      <div className="param-grid">
        <label>Point size</label>
        <input
          type="range" min={1} max={8} step={0.5}
          value={params.pointSize}
          onChange={(e) => params.setPointSize(Number(e.target.value))}
        />
        <label>Color mode</label>
        <select
          value={params.colorMode}
          onChange={(e) => params.setColorMode(e.target.value as 'intensity' | 'height')}
        >
          <option value="intensity">intensity</option>
          <option value="height">height (z)</option>
        </select>
        <label>Voice alerts</label>
        <input
          type="checkbox"
          checked={params.voiceAlerts}
          onChange={(e) => params.setVoiceAlerts(e.target.checked)}
        />
      </div>
      <div className="param-remote">
        <div className="param-remote-title">Remote (set_param)</div>
        <input placeholder="node" value={node} onChange={(e) => setNode(e.target.value)} />
        <input placeholder="parameter" value={name} onChange={(e) => setName(e.target.value)} />
        <input placeholder="value" value={value} onChange={(e) => setValue(e.target.value)} />
        <button onClick={() => void sendParam()} disabled={sending || !name.trim()}>
          {sending ? 'sending…' : 'Send'}
        </button>
        {ack && <span className={`param-ack param-ack-${ack.kind}`}>{ack.text}</span>}
      </div>
    </PanelShell>
  )
}
