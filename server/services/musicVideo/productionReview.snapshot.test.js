import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approveProductionStage, productionAlignmentBasis, productionReadiness, recordProductionFeedback,
  reviewedSceneSnapshot, slimProductionReview } from './productionReview.js';
import * as logic from './projectsLogic.js';
import { createProjectFileStore } from '../projectFileStore.js';

const TAKE_PROMPT = 'Composed take prompt. '.repeat(190); // about 4 KB, like a real composed prompt
const TAKES_PER_SHOT = 400;
const takesFor = sceneId => Array.from({ length: TAKES_PER_SHOT }, (_, i) => ({
  takeId: `${sceneId}-t${i}`, kind: 'video', assetId: `asset-${sceneId}-${i}`, prompt: `${TAKE_PROMPT}#${i}`,
  plateEvidence: { verdict: 'pass', notes: 'Plate matches the reference sheet.' }, createdAt: '2026-01-01T00:00:00.000Z',
}));

// A verified two-shot Board storyboard whose shots carry a long take history (800 takes, about 3 MB).
function readyProject() {
  const base = {
    id: 'mv-snapshot', name: 'Snapshot test', updatedAt: '2026-01-01T00:00:00.000Z', audioAnalysis: { durationSec: 8 },
    lyricCues: [{ id: 'c1', text: 'walking home', startSec: 0.6, endSec: 2, words: [{ w: 'walking', startSec: 0.5, endSec: 1 }, { w: 'home', startSec: 1, endSec: 2.24 }] }],
    castAndSets: { status: 'approved', direction: { world: { camera: 'Handheld drift', transitions: 'Hard cut on the downbeat' } } },
    devArtifacts: [{ id: 'g1', mimeType: 'image/png', file: 'guide.png', version: 1 }],
    scenes: [
      { sceneId: 's1', order: 0, label: 'Verse', startSec: 0, endSec: 4, visualIntent: 'She looks up from the monitor', framePrompt: 'Medium shot, desk lamp',
        prompt: 'She looks up', shotSheet: { characters: ['Lead'] }, referenceImageId: 'img-1', videoHistoryId: 'vid-1', selectedTakeMarkedBad: false, takes: takesFor('s1') },
      { sceneId: 's2', order: 1, label: 'Outro', startSec: 4, endSec: 8, visualIntent: 'Film spills onto the floor', framePrompt: 'Wide shot',
        prompt: 'Film spills', referenceImageId: 'img-2', videoHistoryId: null, takes: takesFor('s2') },
    ],
    productionReview: { draft: { lyricsMode: 'vocal', timingStatus: 'verified', storyboard: [], cast: 'The director', environments: 'Edit room',
      visualLanguage: 'Analog grain', motionLanguage: 'Slow push-ins', guideArtifactId: 'g1' } },
  };
  return { ...base, productionReview: { ...base.productionReview, alignmentBasis: productionAlignmentBasis(base) } };
}

const approve = (project, stage) => approveProductionStage(project, { stage, basis: productionReadiness(project).basis[stage] });
const approvedProject = () => approve(approve(readyProject(), 'art'), 'storyboard');
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const approvalState = project => {
  const r = productionReadiness(project);
  return { art: r.art.approved, storyboard: r.storyboard.approved, basis: r.basis };
};

// The record an install wrote before #16210: whole scenes (with takes) in every
// snapshot, and every history entry carrying its input hashes and values.
function oldShape(project) {
  const review = project.productionReview;
  const reviewedRevisions = Object.fromEntries(Object.entries(review.reviewedRevisions)
    .map(([basis, r]) => [basis, { ...r, scenes: structuredClone(project.scenes) }]));
  const fat = review.approvals.storyboard;
  const older = Array.from({ length: 48 }, (_, i) => ({ ...structuredClone(fat), basis: `old-${i}`, approvedAt: `2025-12-0${1 + (i % 9)}T00:00:00.000Z`,
    values: { ...fat.values, padding: TAKE_PROMPT } }));
  return { ...project, productionReview: { ...review, reviewedRevisions, approvalHistory: [...older, ...review.approvalHistory] } };
}

describe('reviewed revision snapshots (#16210)', () => {
  it('keeps the reviewed shot plan and drops takes and render bookkeeping', () => {
    const scene = readyProject().scenes[0];
    const slim = reviewedSceneSnapshot({ ...scene, camera: { move: 'push-in' }, direction: { emotion: 'calm' }, visualLayer: 'footage' });
    expect(slim).toEqual({ sceneId: 's1', order: 0, label: 'Verse', startSec: 0, endSec: 4, visualIntent: 'She looks up from the monitor',
      framePrompt: 'Medium shot, desk lamp', prompt: 'She looks up', shotSheet: { characters: ['Lead'] }, referenceImageId: 'img-1', videoHistoryId: 'vid-1',
      camera: { move: 'push-in' }, direction: { emotion: 'calm' }, visualLayer: 'footage' });
  });

  it('approving a stage on a shot list with a long take history adds kilobytes, not a copy of the takes', () => {
    const ready = readyProject();
    const art = approve(ready, 'art');
    const board = approve(art, 'storyboard');
    // Uniquely catches a snapshot that clones whole scenes: 800 takes are about 3 MB.
    expect(bytes(art) - bytes(ready)).toBeLessThan(8 * 1024);
    expect(bytes(board) - bytes(art)).toBeLessThan(8 * 1024);
    const snapshots = JSON.stringify(board.productionReview.reviewedRevisions);
    expect(snapshots).not.toContain('Composed take prompt');
    expect(snapshots).not.toContain('plateEvidence');
    expect(approvalState(board)).toMatchObject({ art: true, storyboard: true });
  });

  it('feedback on a reviewed revision still shows the exact reviewed draft after the board moves on', () => {
    const board = approvedProject();
    const { basis } = productionReadiness(board);
    const commented = recordProductionFeedback(board, { stage: 'storyboard', target: 'shot: Verse', text: 'Hold longer', decision: 'request-changes', basis: basis.storyboard });
    const reviewedDraft = structuredClone(commented.productionReview.draft);
    const revised = { ...commented, productionReview: { ...commented.productionReview, draft: { ...commented.productionReview.draft, visualLanguage: 'Clean digital' } } };
    const snapshot = revised.productionReview.reviewedRevisions[basis.storyboard];
    expect(snapshot.draft).toEqual(reviewedDraft);
    expect(snapshot.scenes.map(s => [s.sceneId, s.label, s.visualIntent])).toEqual([['s1', 'Verse', 'She looks up from the monitor'], ['s2', 'Outro', 'Film spills onto the floor']]);
    expect(snapshot.scenes.some(s => 'takes' in s)).toBe(false);
  });
});

describe('slimming a review record written before #16210', () => {
  it('shrinks it, is idempotent, and leaves every approval current', () => {
    const current = approvedProject();
    const old = oldShape(current);
    const before = approvalState(old);
    expect(before).toMatchObject({ art: true, storyboard: true });

    const slimmed = logic.beforeSave(old);
    // Uniquely catches a migration that leaves the cloned take history in place.
    expect(bytes(old)).toBeGreaterThan(3 * 1024 * 1024);
    expect(bytes(slimmed.productionReview)).toBeLessThan(bytes(old.productionReview) / 50);
    expect(approvalState(slimmed)).toEqual(before);
    expect(slimmed.productionReview.approvals).toEqual(old.productionReview.approvals);
    expect(slimmed.updatedAt).toBe(old.updatedAt);
    expect(slimmed.scenes).toBe(old.scenes);
    expect(logic.beforeSave(slimmed)).toBe(slimmed);
    expect(logic.beforeSave(current)).toBe(current);

    const history = slimmed.productionReview.approvalHistory;
    expect(history).toHaveLength(old.productionReview.approvalHistory.length);
    for (const [i, entry] of history.entries()) {
      const { inputs: _inputs, values: _values, ...was } = old.productionReview.approvalHistory[i];
      expect(entry).toMatchObject(was);
    }
    // Only each stage's latest entry keeps its input hashes and values (they back approvals[stage]).
    expect(history.filter(e => 'inputs' in e || 'values' in e).map(e => e.stage)).toEqual(['art', 'storyboard']);
    for (const [basis, revision] of Object.entries(slimmed.productionReview.reviewedRevisions)) {
      expect(revision.draft).toEqual(old.productionReview.reviewedRevisions[basis].draft);
      expect(revision.scenes).toEqual(old.productionReview.reviewedRevisions[basis].scenes.map(reviewedSceneSnapshot));
    }
  });

  it('passes through a record without a review untouched', () => {
    expect(slimProductionReview(undefined)).toBeUndefined();
    const bare = { id: 'p', scenes: [] };
    expect(logic.beforeSave(bare)).toBe(bare);
  });
});

describe('store write path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mv-review-slim-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('a read leaves an old record as stored; its next write shrinks it', async () => {
    const file = join(dir, 'music-video-projects.json');
    const old = oldShape(approvedProject());
    writeFileSync(file, JSON.stringify([old]));
    const store = createProjectFileStore({ file, kind: 'musicVideoProject', idPrefix: 'mv', logEmoji: '🎞️', logLabel: 'Music Video', logic });
    const storedBytes = readFileSync(file).length;

    const read = await store.getProject(old.id);
    expect(read.updatedAt).toBe(old.updatedAt);
    expect(Object.values(read.productionReview.reviewedRevisions).some(r => r.scenes.some(s => s.takes))).toBe(true);
    expect(readFileSync(file).length).toBe(storedBytes);

    const written = await store.updateProject(old.id, { name: 'Renamed' });
    const after = JSON.parse(readFileSync(file, 'utf8'))[0];
    expect(readFileSync(file).length).toBeLessThan(storedBytes);
    expect(JSON.stringify(after.productionReview.reviewedRevisions)).not.toContain('Composed take prompt');
    expect(after.scenes[0].takes).toHaveLength(TAKES_PER_SHOT);
    expect(written.productionReview).toEqual(after.productionReview);
    expect(approvalState(after)).toMatchObject({ art: true, storyboard: true });
  });
});
