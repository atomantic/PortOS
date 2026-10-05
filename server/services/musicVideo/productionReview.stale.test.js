import { describe, it, expect } from 'vitest';
import { productionReadiness } from './productionReview.js';

// Approval records the labeled inputs it was granted on, so a later change can be named.
const approvedArt = (project) => ({ ...project, productionReview: { ...project.productionReview,
  approvals: { art: { stage: 'art', basis: productionReadiness(project).basis.art, inputs: productionReadiness(project).inputs.art, approvedAt: '2026-01-01T00:00:00.000Z' } } } });

describe('stale approval reporting', () => {
  const base = { id: 'p1', concept: 'Example concept', scenes: [{ sceneId: 's1', startSec: 0, endSec: 4, prompt: 'a' }, { sceneId: 's2', startSec: 4, endSec: 8, prompt: 'b' }], productionReview: { draft: {} } };

  it('names the changed inputs once an approved basis moves', () => {
    const approved = approvedArt(base);
    expect(productionReadiness(approved).art.stale).toBeNull();
    const changed = { ...approved, concept: 'Different concept' };
    expect(productionReadiness(changed).art.stale).toEqual({ approvedAt: '2026-01-01T00:00:00.000Z', changedFields: ['concept'] });
  });

  it('reports no stale state for a stage that was never approved', () => {
    expect(productionReadiness(base).art.stale).toBeNull();
  });

  it('labels per-scene edits for the storyboard stage', () => {
    const inputs = productionReadiness(base).inputs.storyboard;
    const edited = productionReadiness({ ...base, scenes: [base.scenes[0], { ...base.scenes[1], prompt: 'c' }] }).inputs.storyboard;
    expect(Object.keys(edited).filter(k => edited[k] !== inputs[k])).toEqual(['scene 2 prompt']);
  });
});
