import { describe, it, expect } from 'vitest';
import { castAndSetsApprovalInputs, productionReadiness } from './productionReview.js';

const castAndSetsApproval = (project) => productionReadiness(project).castAndSets;

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

describe('Cast & Sets approval basis', () => {
  const project = { id: 'p1', trackId: 't1', concept: { prompt: 'Example concept', style: 'ink', subjects: [{ id: 's1' }] },
    visualSpec: { palette: ['#000000'], references: [{ id: 'r1', imageId: 'a.png', role: 'character' }] } };
  const approved = (p) => ({ ...p, castAndSets: { status: 'approved', approvedAt: '2026-01-01T00:00:00.000Z', approvedInputs: castAndSetsApprovalInputs(p) } });

  it('names concept, style, subject and song changes separately', () => {
    const base = approved(project);
    expect(castAndSetsApproval(base)).toEqual({ approved: true, stale: null });
    const edited = { ...base, trackId: 't2', concept: { ...project.concept, style: 'oil' }, visualSpec: { ...project.visualSpec, references: [] } };
    expect(castAndSetsApproval(edited).stale.changedFields).toEqual(['style', 'subjects', 'song']);
  });

  it('ignores a reference re-normalized with default fields, and never flags a legacy approval without recorded inputs', () => {
    const base = approved(project);
    const normalized = { ...base, visualSpec: { ...project.visualSpec, typography: '', references: [{ id: 'r1', imageId: 'a.png', role: 'character', note: '', use: 'reference', condition: false }] } };
    expect(castAndSetsApproval(normalized).stale).toBeNull();
    const legacy = { ...project, concept: { prompt: 'Changed' }, castAndSets: { status: 'approved', approvedAt: '2026-01-01T00:00:00.000Z' } };
    expect(castAndSetsApproval(legacy)).toEqual({ approved: true, stale: null });
  });
});
