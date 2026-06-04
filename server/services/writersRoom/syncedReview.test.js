import { describe, it, expect } from 'vitest';
import { buildSyncedReview } from './syncedReview.js';
import { buildSegmentIndex } from './local.js';

// Realistic body so segment offsets line up with the sliced text the UI shows.
const BODY = '# Opening\nThe hero wakes at dawn.\n\n# Battle\nSwords clash loudly.';
const SEGMENTS = buildSegmentIndex(BODY); // → seg-001 (Opening), seg-002 (Battle)

function makeManifest({ contentHash = 'hash-current' } = {}) {
  return {
    id: 'wr-work-abc',
    title: 'Test Work',
    activeDraftVersionId: 'wr-draft-1',
    drafts: [{ id: 'wr-draft-1', contentHash, segmentIndex: SEGMENTS }],
  };
}

function makeScriptAnalysis(overrides = {}) {
  return {
    id: 'script',
    status: 'succeeded',
    draftVersionId: 'wr-draft-1',
    sourceContentHash: 'hash-current',
    providerId: 'openai',
    model: 'gpt-x',
    completedAt: '2026-01-01T00:00:00Z',
    result: {
      title: 'The Tale',
      logline: 'A hero rises.',
      scenes: [
        { id: 'scene-01', heading: 'Opening', summary: 'wakes', sourceSegmentIds: ['seg-001'], characters: ['Hero'] },
        // seg-999 is a hallucinated/stale ref that must be dropped
        { id: 'scene-02', heading: 'Battle', summary: 'fight', sourceSegmentIds: ['seg-002', 'seg-999'], characters: [] },
      ],
    },
    sceneImages: {
      'scene-01': { filename: 'scene-01.png', jobId: 'job-1', prompt: 'a hero at dawn', generatedAt: '2026-01-02T00:00:00Z' },
      // image whose scene id no longer matches any scene → orphan
      'scene-orphan': { filename: 'orphan.png', jobId: 'job-2', prompt: 'ghost', generatedAt: '2026-01-03T00:00:00Z' },
    },
    ...overrides,
  };
}

describe('buildSyncedReview — prose pane', () => {
  it('derives prose segments with sliced body text', () => {
    const out = buildSyncedReview({ manifest: makeManifest(), body: BODY, scriptAnalysis: null });
    expect(out.prose.segments).toHaveLength(2);
    const [opening, battle] = out.prose.segments;
    expect(opening.id).toBe('seg-001');
    expect(opening.heading).toBe('Opening');
    expect(opening.text).toContain('hero wakes at dawn');
    expect(battle.text).toContain('Swords clash loudly');
  });

  it('returns empty prose when there is no active draft', () => {
    const manifest = { id: 'wr-work-x', title: 'Empty', activeDraftVersionId: null, drafts: [] };
    const out = buildSyncedReview({ manifest, body: '', scriptAnalysis: null });
    expect(out.prose.segments).toEqual([]);
    expect(out.draftVersionId).toBeNull();
    expect(out.script.available).toBe(false);
  });
});

describe('buildSyncedReview — script pane & mappings', () => {
  it('maps scenes to prose and back-fills prose → scene', () => {
    const out = buildSyncedReview({ manifest: makeManifest(), body: BODY, scriptAnalysis: makeScriptAnalysis() });
    expect(out.script.available).toBe(true);
    expect(out.script.title).toBe('The Tale');
    const [opening, battle] = out.prose.segments;
    expect(opening.scriptSceneIds).toEqual(['scene-01']);
    expect(battle.scriptSceneIds).toEqual(['scene-02']);
    // and the scene → prose direction
    expect(out.script.scenes[0].proseSegmentIds).toEqual(['seg-001']);
  });

  it('drops hallucinated/stale sourceSegmentIds that no longer exist in prose', () => {
    const out = buildSyncedReview({ manifest: makeManifest(), body: BODY, scriptAnalysis: makeScriptAnalysis() });
    const battleScene = out.script.scenes.find((s) => s.id === 'scene-02');
    // the LLM referenced seg-002 (valid) + seg-999 (gone); only the valid one
    // survives into the mapping the UI renders
    expect(battleScene.proseSegmentIds).toEqual(['seg-002']);
  });

  it('flags stale when the analysis hash no longer matches the active draft', () => {
    const fresh = buildSyncedReview({ manifest: makeManifest(), body: BODY, scriptAnalysis: makeScriptAnalysis() });
    expect(fresh.script.stale).toBe(false);
    const drifted = buildSyncedReview({
      manifest: makeManifest({ contentHash: 'hash-new' }),
      body: BODY,
      scriptAnalysis: makeScriptAnalysis(),
    });
    expect(drifted.script.stale).toBe(true);
  });

  it('treats a missing script analysis as a normal empty state', () => {
    const out = buildSyncedReview({ manifest: makeManifest(), body: BODY, scriptAnalysis: null });
    expect(out.script.available).toBe(false);
    expect(out.script.scenes).toEqual([]);
    expect(out.media.items).toEqual([]);
    expect(out.prose.segments[0].scriptSceneIds).toEqual([]);
  });

  it('surfaces a failed analysis error and reports no scenes', () => {
    const out = buildSyncedReview({
      manifest: makeManifest(),
      body: BODY,
      scriptAnalysis: { id: 'script', status: 'failed', error: 'boom', result: null },
    });
    expect(out.script.available).toBe(false);
    expect(out.script.status).toBe('failed');
    expect(out.script.error).toBe('boom');
  });
});

describe('buildSyncedReview — media pane & provenance', () => {
  it('attaches scene images to scene + prose and builds the media pane newest-first', () => {
    const out = buildSyncedReview({ manifest: makeManifest(), body: BODY, scriptAnalysis: makeScriptAnalysis() });
    // scene → media
    const openingScene = out.script.scenes.find((s) => s.id === 'scene-01');
    expect(openingScene.media).toMatchObject({ kind: 'image', ref: 'scene-01.png', jobId: 'job-1' });
    // prose → media (back-filled with the source scene id)
    expect(out.prose.segments[0].media).toEqual([
      { kind: 'image', ref: 'scene-01.png', jobId: 'job-1', prompt: 'a hero at dawn', generatedAt: '2026-01-02T00:00:00Z', sceneId: 'scene-01' },
    ]);
    // media pane: two items, newest (orphan, Jan 3) first
    expect(out.media.items).toHaveLength(2);
    expect(out.media.items[0].ref).toBe('orphan.png');
    expect(out.media.items[1].ref).toBe('scene-01.png');
  });

  it('marks an image whose scene no longer exists as an orphan with no prose mapping', () => {
    const out = buildSyncedReview({ manifest: makeManifest(), body: BODY, scriptAnalysis: makeScriptAnalysis() });
    const orphan = out.media.items.find((m) => m.ref === 'orphan.png');
    expect(orphan.orphan).toBe(true);
    expect(orphan.sceneHeading).toBeNull();
    expect(orphan.proseSegmentIds).toEqual([]);
    const mapped = out.media.items.find((m) => m.ref === 'scene-01.png');
    expect(mapped.orphan).toBe(false);
    expect(mapped.sceneHeading).toBe('Opening');
    expect(mapped.proseSegmentIds).toEqual(['seg-001']);
  });

  it('ignores scene-image entries with no filename', () => {
    const analysis = makeScriptAnalysis({
      sceneImages: { 'scene-01': { filename: '', jobId: 'job-x' } },
    });
    const out = buildSyncedReview({ manifest: makeManifest(), body: BODY, scriptAnalysis: analysis });
    expect(out.media.items).toEqual([]);
    expect(out.script.scenes[0].media).toBeNull();
  });
});
