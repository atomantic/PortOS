import { describe, expect, it } from 'vitest';
import { analyzeEvidence, evaluateVerdict } from './evidence.js';

const manifest = (overrides = {}) => ({
  format: { width: 1280, height: 720, fps: 12, durationSeconds: 6 }, events: [], audio: { kind: 'silence' }, ...overrides,
});
const contract = { durationSec: 6, fps: 12, width: 1280, height: 720 };
const samples = (hashes, { mean = 80, deviation = 20 } = {}) => hashes.map((renderHash, index) => ({ t: index, renderHash, mean, deviation }));
const kinds = result => result.findings.map(finding => `${finding.severity}:${finding.kind}`);

describe('production evidence analysis', () => {
  it('reports what the samples measure and nothing more', () => {
    expect(kinds(analyzeEvidence({ manifest: manifest(), pilot: { samples: samples(['a', 'b', 'c', 'd']) }, contract }))).toEqual([]);
    expect(kinds(analyzeEvidence({ manifest: manifest(), pilot: { samples: samples(['a', 'a', 'a', 'a']) }, contract }))).toEqual(['error:frozen-film']);
    // A 3s freeze in a 6s film is half the film: an error. A 2s one is a warning.
    expect(kinds(analyzeEvidence({ manifest: manifest(), pilot: { samples: samples(['a', 'b', 'b', 'b', 'c', 'd']) }, contract }))).toEqual(['warning:frozen-span']);
    expect(kinds(analyzeEvidence({ manifest: manifest(), pilot: { samples: samples(['a', 'b', 'b', 'b', 'b', 'c']) }, contract }))).toEqual(['error:frozen-span']);
    expect(kinds(analyzeEvidence({ manifest: manifest(), pilot: { samples: samples(['a', 'b', 'c', 'd'], { mean: 0.5 }) }, contract }))).toEqual(['error:blank-film']);
    expect(kinds(analyzeEvidence({ manifest: manifest(), pilot: { samples: samples(['a', 'b']) }, contract: { ...contract, durationSec: 9, width: 640 } })))
      .toEqual(['error:duration-mismatch', 'error:frame-size-mismatch']);
  });

  it('rejects a renderer using a different frame grid than the sound timeline', () => {
    expect(kinds(analyzeEvidence({ manifest: manifest(), pilot: { samples: samples(['a', 'b']) }, contract: { ...contract, fps: 24 } })))
      .toEqual(['error:frame-rate-mismatch']);
  });

  it('flags a declared event with no visible change, and keeps unmeasured dimensions unverified', () => {
    const withEvent = manifest({ events: [{ label: 'Hop', atSeconds: 1.5 }], audio: { kind: 'external', notes: 'x' } });
    const result = analyzeEvidence({ manifest: withEvent, pilot: { samples: samples(['a', 'b', 'c', 'c', 'c', 'f']).map(sample => ({ ...sample, t: sample.t / 2 })) }, contract });
    expect(kinds(result)).toEqual(['warning:event-without-change']);
    expect(result.verified).not.toContain('audio');
    expect(result.unverified.map(item => item.dimension)).toEqual(['audio', 'semantic-visual']);
    // A canvas that cannot be read back is unverified, never "not blank".
    const unreadable = analyzeEvidence({ manifest: manifest(), pilot: { samples: samples(['a', 'b'], { mean: null, deviation: null }) }, contract });
    expect(unreadable.verified).not.toContain('blank-frame');
    expect(unreadable.unverified.map(item => item.dimension)).toContain('blank-frame');
  });
});

describe('production verdict', () => {
  const evidence = { sourceHash: 'h1' };
  it('passes only fresh, error-free evidence', () => {
    expect(evaluateVerdict({ evidence, sourceHash: 'h1', findings: [{ severity: 'warning' }], unverified: [] }).status).toBe('pass');
    expect(evaluateVerdict({ evidence, sourceHash: 'h1', findings: [{ severity: 'error' }], unverified: [] }).status).toBe('fail');
    expect(evaluateVerdict({ evidence, sourceHash: 'h2', findings: [], unverified: [] }).status).toBe('stale');
    expect(evaluateVerdict({ evidence: { sourceHash: null }, sourceHash: 'h1', findings: [], unverified: [] }).status).toBe('unverified');
    expect(evaluateVerdict({ evidence: null, sourceHash: 'h1', findings: [], unverified: [] }).status).toBe('unverified');
  });
});
