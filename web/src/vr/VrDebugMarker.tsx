/** TEMPORARY diagnostic. A fixed, dependency-free set of reference objects placed
 *  in raw world space (NOT inside SceneRoot, so no rotation/scale/data feeds can
 *  hide them). If these render in VR, the session + camera + render loop work and
 *  the problem is in the scene content; if they DON'T, it's a fundamental render
 *  issue. Remove once VR rendering is confirmed.
 *
 *  Layout (you start facing -Z):
 *   - magenta box ~eye height, 1.2 m ahead
 *   - green box at floor level, 1.2 m ahead
 *   - world axes at your feet (red=+X right, green=+Y up, blue=+Z back) */
export function VrDebugMarker() {
  return (
    <group>
      <mesh position={[0, 1.4, -1.2]}>
        <boxGeometry args={[0.35, 0.35, 0.35]} />
        <meshBasicMaterial color="magenta" />
      </mesh>
      <mesh position={[0, 0.05, -1.2]}>
        <boxGeometry args={[0.35, 0.1, 0.35]} />
        <meshBasicMaterial color="#22dd55" />
      </mesh>
      {/* a tall thin pole connecting them so it's unmissable */}
      <mesh position={[0, 0.75, -1.2]}>
        <boxGeometry args={[0.05, 1.5, 0.05]} />
        <meshBasicMaterial color="#ffffff" />
      </mesh>
      <axesHelper args={[1]} />
    </group>
  )
}
