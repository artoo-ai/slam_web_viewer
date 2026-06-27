import { describe, expect, it, beforeEach } from 'vitest'
import { useVrStore, clampWorldScale, MIN_WORLD_SCALE, MAX_WORLD_SCALE } from './vrModeStore'

describe('vrModeStore', () => {
  beforeEach(() =>
    useVrStore.setState({
      mode: 'none',
      environment: 'void',
      joystickMode: 'move',
      viewMode: 'free',
      worldScale: 1,
    }),
  )

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

  it('defaults the environment to void', () => {
    expect(useVrStore.getState().environment).toBe('void')
  })

  it('setEnvironment toggles void ↔ passthrough', () => {
    useVrStore.getState().setEnvironment('passthrough')
    expect(useVrStore.getState().environment).toBe('passthrough')
    useVrStore.getState().setEnvironment('void')
    expect(useVrStore.getState().environment).toBe('void')
  })

  it('defaults joystick to move and view to free', () => {
    expect(useVrStore.getState().joystickMode).toBe('move')
    expect(useVrStore.getState().viewMode).toBe('free')
  })

  it('setJoystickMode and setViewMode update their fields', () => {
    useVrStore.getState().setJoystickMode('drive')
    expect(useVrStore.getState().joystickMode).toBe('drive')
    useVrStore.getState().setViewMode('robot')
    expect(useVrStore.getState().viewMode).toBe('robot')
  })
})
