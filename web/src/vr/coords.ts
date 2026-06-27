/** REP-103 world is Z-up; WebXR player space is Y-up. Rotating the scene by
 *  -90° about X maps scene +Z onto world +Y so the map floor is the real floor. */
export const Z_UP_TO_Y_UP: [number, number, number] = [-Math.PI / 2, 0, 0]
