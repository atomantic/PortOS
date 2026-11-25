import { describe, expect, it } from 'vitest';
import {
  LOCAL_RUNTIME_MARKERS,
  LOCAL_RUNTIME_MARKER_KEYS,
  hasLocalRuntimeMarker,
  markedLocalRuntime,
} from './localRuntimeMarkers.js';

describe('local runtime marker registry', () => {
  it('pins the persisted field names and resolution order', () => {
    // These booleans are the stored record format (federated, read by older installs): never rename.
    // Order is behavior: the first marker set wins in `markedLocalRuntime`.
    expect(Object.entries(LOCAL_RUNTIME_MARKERS)).toEqual([
      ['ollama', 'ollamaBacked'],
      ['lmstudio', 'lmstudioBacked'],
      ['mtplx', 'mtplxBacked'],
      ['llama', 'llamaBacked'],
      ['vllm', 'vllmBacked'],
      ['sglang', 'sglangBacked'],
      ['splash', 'splashBacked'],
    ]);
    expect(LOCAL_RUNTIME_MARKER_KEYS).toEqual(Object.values(LOCAL_RUNTIME_MARKERS));
  });

  it('answers with the first marker when a malformed record carries several', () => {
    expect(markedLocalRuntime({ splashBacked: true, vllmBacked: true, llamaBacked: true })).toBe('llama');
    expect(markedLocalRuntime({ sglangBacked: true, splashBacked: true })).toBe('sglang');
  });

  it('reads only a literal true and tolerates absent or non-record input', () => {
    for (const provider of [null, undefined, {}, { ollamaBacked: 'true' }, { vllmBacked: 1 }, { splashBacked: false }]) {
      expect(markedLocalRuntime(provider)).toBeNull();
      expect(hasLocalRuntimeMarker(provider)).toBe(false);
    }
    expect(hasLocalRuntimeMarker({ mtplxBacked: true })).toBe(true);
  });

  it('does not treat a gateway marker as a local runtime', () => {
    expect(hasLocalRuntimeMarker({ gatewayBacked: 'openrouter', orcarouterBacked: true })).toBe(false);
  });
});
