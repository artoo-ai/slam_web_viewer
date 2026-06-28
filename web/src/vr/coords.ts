/** REP-103 world is Z-up (X forward, Y left); WebXR player space is Y-up (X right,
 *  -Z forward). This maps the scene into the headset's frame:
 *    scene +Z (up)      → world +Y (up)      — map floor is the real floor
 *    scene +X (forward) → world -Z (forward) — you face down the map's forward axis
 *    scene +Y (left)    → world -X (left)
 *  Implemented as Ry(+90°)·Rx(-90°); the Euler-XYZ form is [-90°, 0, +90°]. Without
 *  the yaw term you spawn looking 90° sideways. Shared by SceneRoot and the
 *  robot-POV rig so the world and the ride-along view stay consistent. */
export const Z_UP_TO_Y_UP: [number, number, number] = [-Math.PI / 2, 0, Math.PI / 2]
