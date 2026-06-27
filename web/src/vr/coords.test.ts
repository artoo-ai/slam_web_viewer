import { describe, expect, it } from 'vitest'
import { Euler, Vector3 } from 'three'
import { Z_UP_TO_Y_UP } from './coords'

describe('Z_UP_TO_Y_UP', () => {
  it('maps scene-up (+Z) to world-up (+Y)', () => {
    const v = new Vector3(0, 0, 1).applyEuler(new Euler(...Z_UP_TO_Y_UP))
    expect(v.x).toBeCloseTo(0, 5)
    expect(v.y).toBeCloseTo(1, 5)
    expect(v.z).toBeCloseTo(0, 5)
  })
})
