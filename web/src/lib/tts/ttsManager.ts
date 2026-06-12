/** Voice alerts via the Web Speech API. Warnings preempt informational
 *  messages; duplicate messages within a cooldown are suppressed. Gated by the
 *  "Voice alerts" toggle in the Parameters panel. Kokoro-js (higher-quality,
 *  client-side neural TTS) is the planned upgrade — same interface. */

import { useViewerParams } from '../../stores/viewerParamsStore'
import { useTelemetryStore } from '../../stores/telemetryStore'
import type { StatusPayload } from '../../types/channels'

const COOLDOWN_MS = 5000

const STATUS_MESSAGES: Record<string, string | ((s: StatusPayload) => string)> = {
  loop_closure: 'Loop closure. Map updated.',
  tracking_lost: 'Warning. Tracking lost.',
  imu_drift: 'Warning. IMU drift detected.',
  low_battery: 'Low battery.',
  object_detected: (s) => `${s.count ?? 'an'} ${s.label ?? 'object'} detected.`,
}

const lastSpoken = new Map<string, number>()

function speak(text: string, warning = false) {
  if (!useViewerParams.getState().voiceAlerts) return
  if (!('speechSynthesis' in window)) return
  const now = performance.now()
  const last = lastSpoken.get(text)
  if (last !== undefined && now - last < COOLDOWN_MS) return
  lastSpoken.set(text, now)
  if (warning) window.speechSynthesis.cancel() // warnings preempt the queue
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.rate = 1.15
  window.speechSynthesis.speak(utterance)
}

/** Public hook for other modules (config audit etc.) to voice a warning. */
export function speakAlert(text: string) {
  speak(text, true)
}

/** Non-preempting announcement (milestones like exploration complete). */
export function speakNotice(text: string) {
  speak(text, false)
}

let booted = false

/** Idempotent: subscribes to status events and watches the smear alarm. */
export function bootTts() {
  if (booted) return
  booted = true

  useTelemetryStore.subscribe((state, prev) => {
    const event = state.lastStatusEvent
    if (!event || event === prev.lastStatusEvent) return
    const template = STATUS_MESSAGES[event.event]
    if (!template) return
    const text = typeof template === 'function' ? template(event) : template
    speak(text, event.event.startsWith('tracking') || event.event.includes('drift'))
  })

  // (the smear alarm is voiced by the alert system — AlertBanners raises
  // 'rotation-smearing' and alertsStore speaks error-severity alerts)
}
