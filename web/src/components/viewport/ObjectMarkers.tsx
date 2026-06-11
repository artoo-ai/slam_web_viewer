import { useObjectsStore } from '../../stores/objectsStore'

/** Semantic object markers: a diamond pin per object at its map position.
 *  Details (thumbnail, label) live in the Objects tab of the metrics card. */
export function ObjectMarkers() {
  const objects = useObjectsStore((s) => s.objects)
  return (
    <>
      {objects.map((o) => (
        <group key={o.id} position={[o.p[0], o.p[1], o.p[2] + 0.45]}>
          <mesh rotation={[Math.PI / 4, 0, Math.PI / 4]}>
            <octahedronGeometry args={[0.14]} />
            <meshBasicMaterial color="#e879f9" />
          </mesh>
          <mesh position={[0, 0, -0.25]}>
            <cylinderGeometry args={[0.012, 0.012, 0.4, 6]} />
            <meshBasicMaterial color="#e879f9" transparent opacity={0.6} />
          </mesh>
        </group>
      ))}
    </>
  )
}
