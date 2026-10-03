import { describe, expect, it } from 'vitest';
import { acceptanceFreshness, acceptanceProblem, freezeAcceptance } from './codeAnimationAcceptance.js';

describe('freezeAcceptance', () => {
  it('keeps the four dimensions apart and never turns an unmeasured dimension into a pass', () => {
    const run = { id: 'r', data: { findings: [{ kind: 'frozen-span', severity: 'error', detail: 'x' }], output: { revisionId: 'v', sourceHash: 'h', packageHash: 'p', videoId: 'x', filename: 'a.mp4',
      verifiedDimensions: ['frame-size', 'timing', 'visual-motion'], unverified: [{ dimension: 'semantic-visual', reason: 'No reviewer ran.' }] } } };
    const { evidence } = freezeAcceptance({ run, project: { title: 't', manifest: { format: {} } }, renderHash: 'r' });
    expect(evidence.technical.status).toBe('verified');
    expect(evidence.visual.status).toBe('partial');
    expect(evidence.temporal.status).toBe('failed');
    expect(evidence.sound).toMatchObject({ status: 'unverified', verified: [] });
    expect(evidence.sound.unverified.map(item => item.dimension)).toContain('hearing');
  });
});

describe('acceptanceFreshness', () => {
  const frozen = { sourceHash: 's', audioHash: 'a', renderHash: 'r' };
  it('is fresh only when source, audio and render all match', () => {
    expect(acceptanceFreshness(frozen, { sourceHash: 's', audioHash: 'a', renderHash: 'r' }).fresh).toBe(true);
    const stale = acceptanceFreshness(frozen, { sourceHash: 's2', audioHash: 'unreadable', renderHash: 'r' });
    expect(stale.stale.map(item => item.dimension)).toEqual(['source', 'audio']);
  });
});

describe('acceptanceProblem', () => {
  const run = { status: 'completed', data: { kind: 'production-stages', verdict: { status: 'pass', revisionId: 'v', sourceHash: 'h' }, output: { videoId: 'x', revisionId: 'v', sourceHash: 'h', filename: 'a.mp4' } } };
  it('refuses an output rendered from a different source than the evidence measured', () => {
    expect(acceptanceProblem(run)).toBeNull();
    expect(acceptanceProblem({ ...run, data: { ...run.data, output: { ...run.data.output, sourceHash: 'other' } } })).toMatch(/different source/);
  });
});
