// Pure, deterministic helpers for CyberCity's voice-agent district marker (roadmap 2.4):
// a small ground-level beacon north of downtown whose lighting mirrors the voice agent's
// live state — calm slate when idle, accent blue while listening, green while dictating,
// red on error, and dimmed when voice mode is disabled. The live state is socket-driven
// (`voice:idle` / `voice:dictation` / `voice:error`); the `enabled` flag comes from the
// persisted /voice/status payload. No three.js / React imports so the topology is
// unit-testable (mirrors cityBackupVault.js).

import { PARCELS } from './cityPlan';

export const MARKER = {
  position: PARCELS.voice.anchor, // north of downtown, stepped just off the harbor avenue's
  // centerline so the plaza→harbor walkway runs clear past the beacon (see cityPlan.js).
  baseRadius: 2.2,
  poleHeight: 6,
  beaconRadius: 0.9,
};

// Beacon color per voice state — reuses the PortOS Tailwind design tokens so the marker
// speaks the same visual language as the rest of the UI.
const STATE_COLORS = {
  idle: '#475569', // slate — voice mode on, nothing happening
  listening: '#3b82f6', // port-accent — capturing a turn
  dictating: '#22c55e', // port-success — dictation appending to the daily log
  error: '#ef4444', // port-error — a turn failed
  disabled: '#1e293b', // dim slate — voice mode off
};

const STATE_LABELS = {
  idle: 'STANDBY',
  listening: 'LISTENING',
  dictating: 'DICTATING',
  error: 'VOICE ERROR',
  disabled: 'VOICE OFF',
};

// Emissive intensity per state — the marker glows brightest while actively working
// (listening / dictating), throbs on error, sits calm when idle, and barely lights when
// disabled so it reads as "asleep" without disappearing.
const STATE_INTENSITY = {
  idle: 0.45,
  listening: 1,
  dictating: 1,
  error: 0.9,
  disabled: 0.12,
};

const VALID_STATES = new Set(['idle', 'listening', 'dictating', 'error', 'disabled']);

// Derive the marker's live state from the voice view payload. `enabled` is the persisted
// flag; `live` is the latest socket-driven sub-state (idle | listening | dictating | error).
// Voice mode is treated as off unless `enabled === true` — an absent flag (status fetch
// failed / voice never configured) reads as `disabled`, never as a live "on" state. A stale
// live value is ignored while disabled. An unrecognized live value falls back to `idle`.
export function markerState(voice) {
  if (!voice || voice.enabled !== true) return 'disabled';
  const live = voice.live;
  if (live === 'error') return 'error';
  if (live === 'dictating') return 'dictating';
  if (live === 'listening') return 'listening';
  return 'idle';
}

export function markerColor(state) {
  return STATE_COLORS[VALID_STATES.has(state) ? state : 'idle'] || STATE_COLORS.idle;
}

export function markerLabel(state) {
  return STATE_LABELS[VALID_STATES.has(state) ? state : 'idle'] || STATE_LABELS.idle;
}

// Should the beacon pulse urgently (error) vs. calmly? Listening/dictating get an active
// pulse; idle breathes slowly; disabled doesn't animate.
export function markerIsActive(state) {
  return state === 'listening' || state === 'dictating';
}

// Full derived view-model for the component: position + state + color + label + flags +
// emissive intensity. Mirrors computeBackupVault's shape so the component layer stays thin.
export function computeVoiceMarker(voice) {
  const state = markerState(voice);
  return {
    position: MARKER.position,
    baseRadius: MARKER.baseRadius,
    poleHeight: MARKER.poleHeight,
    beaconRadius: MARKER.beaconRadius,
    state,
    color: markerColor(state),
    label: markerLabel(state),
    active: markerIsActive(state),
    alerting: state === 'error',
    disabled: state === 'disabled',
    intensity: STATE_INTENSITY[state] ?? STATE_INTENSITY.idle,
  };
}
