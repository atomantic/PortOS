import { describe, it, expect } from 'vitest';
import {
  MARKER,
  markerState,
  markerColor,
  markerLabel,
  markerIsActive,
  computeVoiceMarker,
} from './cityVoiceMarker';

describe('markerState', () => {
  it('is disabled when voice mode is off, regardless of a stale live value', () => {
    expect(markerState({ enabled: false })).toBe('disabled');
    expect(markerState({ enabled: false, live: 'listening' })).toBe('disabled');
  });

  it('is disabled for missing / empty input', () => {
    expect(markerState(undefined)).toBe('disabled');
    expect(markerState(null)).toBe('disabled');
    expect(markerState({})).toBe('disabled'); // enabled absent → treated as off
  });

  it('maps each live sub-state when voice mode is enabled', () => {
    expect(markerState({ enabled: true, live: 'error' })).toBe('error');
    expect(markerState({ enabled: true, live: 'dictating' })).toBe('dictating');
    expect(markerState({ enabled: true, live: 'listening' })).toBe('listening');
    expect(markerState({ enabled: true, live: 'idle' })).toBe('idle');
  });

  it('falls back to idle for an absent / unrecognized live value when enabled', () => {
    expect(markerState({ enabled: true })).toBe('idle');
    expect(markerState({ enabled: true, live: 'bogus' })).toBe('idle');
  });

  it('prioritizes error over other live states', () => {
    // The live field carries one sub-state, but guard the precedence contract anyway.
    expect(markerState({ enabled: true, live: 'error' })).toBe('error');
  });
});

describe('markerColor', () => {
  it('maps each state to a distinct token', () => {
    expect(markerColor('idle')).toBe('#475569');
    expect(markerColor('listening')).toBe('#3b82f6');
    expect(markerColor('dictating')).toBe('#22c55e');
    expect(markerColor('error')).toBe('#ef4444');
    expect(markerColor('disabled')).toBe('#1e293b');
  });

  it('falls back to idle for an unknown state', () => {
    expect(markerColor('bogus')).toBe(markerColor('idle'));
  });
});

describe('markerLabel', () => {
  it('gives a distinct uppercase label per state', () => {
    expect(markerLabel('idle')).toBe('STANDBY');
    expect(markerLabel('listening')).toBe('LISTENING');
    expect(markerLabel('dictating')).toBe('DICTATING');
    expect(markerLabel('error')).toBe('VOICE ERROR');
    expect(markerLabel('disabled')).toBe('VOICE OFF');
  });

  it('falls back to the idle label for an unknown state', () => {
    expect(markerLabel('bogus')).toBe(markerLabel('idle'));
  });
});

describe('markerIsActive', () => {
  it('is active only while listening or dictating', () => {
    expect(markerIsActive('listening')).toBe(true);
    expect(markerIsActive('dictating')).toBe(true);
    expect(markerIsActive('idle')).toBe(false);
    expect(markerIsActive('error')).toBe(false);
    expect(markerIsActive('disabled')).toBe(false);
  });
});

describe('computeVoiceMarker', () => {
  it('carries the fixed position/geometry through unchanged', () => {
    const vm = computeVoiceMarker({ enabled: true });
    expect(vm.position).toEqual(MARKER.position);
    expect(vm.baseRadius).toBe(MARKER.baseRadius);
    expect(vm.poleHeight).toBe(MARKER.poleHeight);
    expect(vm.beaconRadius).toBe(MARKER.beaconRadius);
  });

  it('derives color/label/flags/intensity for each state', () => {
    const idle = computeVoiceMarker({ enabled: true, live: 'idle' });
    expect(idle).toMatchObject({ state: 'idle', color: '#475569', label: 'STANDBY', active: false, alerting: false, disabled: false });
    expect(idle.intensity).toBeGreaterThan(0);

    const listening = computeVoiceMarker({ enabled: true, live: 'listening' });
    expect(listening).toMatchObject({ state: 'listening', color: '#3b82f6', active: true, alerting: false });

    const dictating = computeVoiceMarker({ enabled: true, live: 'dictating' });
    expect(dictating).toMatchObject({ state: 'dictating', color: '#22c55e', active: true });

    const error = computeVoiceMarker({ enabled: true, live: 'error' });
    expect(error).toMatchObject({ state: 'error', color: '#ef4444', alerting: true, active: false });

    const disabled = computeVoiceMarker({ enabled: false });
    expect(disabled).toMatchObject({ state: 'disabled', color: '#1e293b', disabled: true, active: false });
    expect(disabled.intensity).toBeLessThan(idle.intensity);
  });

  it('treats missing / empty input as disabled', () => {
    expect(computeVoiceMarker(undefined).state).toBe('disabled');
    expect(computeVoiceMarker(null).state).toBe('disabled');
    expect(computeVoiceMarker({}).state).toBe('disabled');
  });

  it('always returns a finite emissive intensity', () => {
    for (const live of ['idle', 'listening', 'dictating', 'error', undefined, 'bogus']) {
      const vm = computeVoiceMarker({ enabled: true, live });
      expect(Number.isFinite(vm.intensity)).toBe(true);
    }
  });
});
