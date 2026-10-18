import { describe, it, expect, vi } from 'vitest';
import { approveProductionStage, productionReadiness, productionAlignmentBasis, recordProductionFeedback } from './productionReview.js';

function artProject(visualLanguage) {
  const base = {
    id: 'p1', audioAnalysis: { durationSec: 8 }, lyricCues: [],
    castAndSets: { status: 'approved', direction: { world: { camera: 'Handheld drift', transitions: 'Hard cut' } } },
    scenes: [{ sceneId: 's1', label: 'Verse', startSec: 0, endSec: 8, visualIntent: 'She looks up', framePrompt: 'Medium shot' }],
    devArtifacts: [{ id: 'g1', mimeType: 'image/png', file: 'guide.png', version: 1 }],
    productionReview: { draft: { lyricsMode: 'instrumental', cast: 'The director', environments: 'Edit room', visualLanguage, motionLanguage: 'Slow push-ins', guideArtifactId: 'g1' } },
  };
  return { ...base, productionReview: { ...base.productionReview, alignmentBasis: productionAlignmentBasis(base) } };
}

// Carries the accumulated review record onto the next revision, as successive project writes do.
const revise = (previous, n) => ({ ...artProject(`Grain ${n}`), productionReview: { ...artProject(`Grain ${n}`).productionReview, ...previous.productionReview, draft: artProject(`Grain ${n}`).productionReview.draft } });
const approve = (p) => approveProductionStage(p, { stage: 'art', basis: productionReadiness(p).basis.art });

describe('production review record growth', () => {
  it('keeps the newest snapshots when captures share one timestamp', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    try {
      let project = artProject('Grain 0');
      for (let n = 0; n < 8; n++) project = approve(revise(project, n));
      const { basis } = productionReadiness(project);
      expect(Object.keys(project.productionReview.reviewedRevisions)).toContain(basis.art);
    } finally { vi.useRealTimers(); }
  });

  it('bounds approval history and revision snapshots across many approvals', () => {
    let project = artProject('Grain 0');
    for (let n = 0; n < 60; n++) project = approve(revise(project, n));
    expect(project.productionReview.approvalHistory).toHaveLength(50);
    expect(Object.keys(project.productionReview.reviewedRevisions)).toHaveLength(5);
    expect(project.productionReview.approvalHistory.at(-1).basis).toBe(project.productionReview.approvals.art.basis);
  });

  it('keeps the snapshot an open comment points at, and drops it once resolved', () => {
    let project = artProject('Grain 0');
    const commentBasis = productionReadiness(project).basis.art;
    project = recordProductionFeedback(project, { stage: 'art', target: 'cast', text: 'Too dark', decision: 'comment', basis: commentBasis });
    for (let n = 1; n < 12; n++) project = approve(revise(project, n));
    expect(project.productionReview.reviewedRevisions[commentBasis]).toBeDefined();
    expect(Object.keys(project.productionReview.reviewedRevisions)).toHaveLength(6);
    const resolved = { ...project.productionReview, feedback: project.productionReview.feedback.map(f => ({ ...f, resolvedAt: 'now' })) };
    const next = approve(revise({ productionReview: resolved }, 99));
    expect(next.productionReview.reviewedRevisions[commentBasis]).toBeUndefined();
  });
});
