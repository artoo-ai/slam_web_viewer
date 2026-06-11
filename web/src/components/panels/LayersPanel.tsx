import { useLayersStore, type LayerVisibility } from '../../stores/layersStore'
import { PanelShell } from './PanelShell'

const LAYERS: { key: keyof LayerVisibility; label: string }[] = [
  { key: 'scan', label: 'Live scan' },
  { key: 'map', label: 'Map' },
  { key: 'costmap_global', label: 'Costmap (global)' },
  { key: 'costmap_local', label: 'Costmap (local)' },
  { key: 'path', label: 'Planned path' },
  { key: 'trajectory', label: 'Trajectory' },
]

export function LayersPanel() {
  const store = useLayersStore()
  return (
    <PanelShell title="Layers">
      <div className="layers-list">
        {LAYERS.map(({ key, label }) => (
          <label key={key} className="layers-item">
            <input type="checkbox" checked={store[key]} onChange={() => store.toggle(key)} />
            {label}
          </label>
        ))}
      </div>
    </PanelShell>
  )
}
