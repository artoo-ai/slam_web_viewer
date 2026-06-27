import { describe, expect, it, beforeEach } from 'vitest'
import { useVrStore, clampWorldScale, MIN_WORLD_SCALE, MAX_WORLD_SCALE } from './vrModeStore'

describe('vrModeStore', () => {
  beforeEach(() => useVrStore.setState({ mode: 'none', worldScale: 1 }))

  it('clamps world scale to the allowed range', () => {
    expect(clampWorldScale(1)).toBe(1)
    expect(clampWorldScale(0.0001)).toBe(MIN_WORLD_SCALE)
    expect(clampWorldScale(999)).toBe(MAX_WORLD_SCALE)
  })

  it('setMode updates the active session mode', () => {
    useVrStore.getState().setMode('ar')
    expect(useVrStore.getState().mode).toBe('ar')
  })

  it('setWorldScale clamps before storing', () => {
    useVrStore.getState().setWorldScale(999)
    expect(useVrStore.getState().worldScale).toBe(MAX_WORLD_SCALE)
  })
})
