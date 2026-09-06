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

// ---- cast integrity (#6415 / #6417) ----

// A fully authored lead: every framework field plus a complete psychology
// profile, so the deterministic pass has nothing to report about it.
const COMPLETE_PSYCHOLOGY = {
  theoryOfControl: 'If I am the one who strikes first, nobody gets to leave me.',
  strategy: 'Pre-empt every goodbye with a fight.',
  protectiveBenefit: 'Never has to hear the words out loud.',
  presentCost: 'Burns every alliance before it can hold weight.',
  testingPressure: 'A partner who refuses to fight back.',
  candidateChange: 'Stays in the room through one argument.',
  assessment: 'assessed',
  assessmentNote: '',
  drives: {
    survival: { desire: 'A locked door of her own', fear: 'Sleeping where she can be reached' },
    connection: { desire: 'One person who stays', fear: 'Being the one who is left' },
    status: { desire: 'To be the one who decides', fear: 'Being spoken about as a burden' },
  },
};

const hero = (overrides = {}) => ({
  id: 'wr-char-hero',
  name: 'Hero',
  aliases: ['The Kid'],
  role: 'protagonist',
  arcType: 'positive',
  motivations: 'Get her brother out of the valley before winter.',
  ghost: 'Her mother walked out during a blizzard.',
  wound: 'Nobody came back for her.',
  lie: 'Anyone who can leave will.',
  need: 'To let someone stay.',
  want: 'A house with a door that locks.',
  secrets: ['She sold the last horse.'],
  psychology: COMPLETE_PSYCHOLOGY,
  ...overrides,
});

const build = (characters, { scriptAnalysis = makeScriptAnalysis() } = {}) =>
  buildSyncedReview({ manifest: makeManifest(), body: BODY, scriptAnalysis, characters });

describe('buildSyncedReview — cast integrity', () => {
  it('reports authored gaps by character id and field path, with evidence', () => {
    const out = build([{ id: 'wr-char-thin', name: 'Hero', role: 'protagonist' }]);
    const fields = out.cast.findings.map((f) => f.field);
    expect(out.cast.available).toBe(true);
    expect(fields).toContain('lie');
    expect(fields).toContain('psychology');
    for (const finding of out.cast.findings) {
      expect(finding.characterId).toBe('wr-char-thin');
      expect(finding.kind).toBe('missing');
      expect(finding.evidence).toBeTruthy();
    }
  });

  it('never reports a clean pass from the deterministic sweep alone', () => {
    const out = build([hero()]);
    expect(out.cast.findings).toHaveLength(0);
    expect(out.cast.coverage[0].status).toBe('passed');
    // Fully populated is NOT integrity — no model has read this cast.
    expect(out.cast.coverage[0].semanticReviewed).toBe(false);
    expect(out.cast.semanticReviewedCount).toBe(0);
    expect(out.cast.passed).toBe(false);
  });

  it('holds a declared minor role to the lighter depth instead of the full framework', () => {
    const out = build([{ id: 'wr-char-guard', name: 'Gate Guard', role: 'minor background guard' }]);
    const [row] = out.cast.coverage;
    expect(row.depth).toBe('light');
    // Light asks for the conscious pursuit only — never a Ghost or a Wound.
    const fields = out.cast.findings.map((f) => f.field);
    expect(fields).toEqual(['motivations', 'want']);
  });

  it('asks nothing further of an interior the author explicitly ruled out', () => {
    const out = build([{
      id: 'wr-char-oracle',
      name: 'The Oracle',
      psychology: { assessment: 'not-applicable', assessmentNote: 'Deliberately unknowable; the reader never gets inside.' },
    }]);
    expect(out.cast.coverage[0].depth).toBe('explained');
    expect(out.cast.findings).toHaveLength(0);
  });

  it('joins each character to the scenes and prose segments that stage them, by name or alias', () => {
    const analysis = makeScriptAnalysis();
    analysis.result.scenes[1].characters = ['The Kid'];
    const out = build([hero()], { scriptAnalysis: analysis });
    const [row] = out.cast.coverage;
    expect(row.staged).toBe(true);
    expect(row.scriptSceneIds).toEqual(['scene-01', 'scene-02']);
    expect(row.proseSegmentIds).toEqual(['seg-001', 'seg-002']);
    // Mirrored onto both other panes so a selection can cross-highlight.
    expect(out.script.scenes[0].castCharacterIds).toEqual(['wr-char-hero']);
    expect(out.prose.segments[0].castCharacterIds).toEqual(['wr-char-hero']);
  });

  it('keeps the cold read separate from author knowledge in both directions', () => {
    const analysis = makeScriptAnalysis();
    analysis.result.scenes[1].characters = ['The Ferryman'];
    const out = build([hero(), { ...hero(), id: 'wr-char-ghost', name: 'Offstage Aunt', aliases: [] }], {
      scriptAnalysis: analysis,
    });
    // A name only the cold read saw never becomes a finding — there is no
    // record to hang a field path on.
    expect(out.cast.staging.unmatchedNames).toEqual(['The Ferryman']);
    expect(out.cast.findings).toHaveLength(0);
    // An authored character no scene stages is a fact, not a defect.
    const offstage = out.cast.coverage.find((c) => c.characterId === 'wr-char-ghost');
    expect(offstage.staged).toBe(false);
    expect(offstage.status).toBe('passed');
    expect(out.cast.staging.stagedCount).toBe(1);
    expect(out.cast.staging.unstagedCount).toBe(1);
  });

  it('reports gaps for a character the prose stages vividly but the bible leaves blank', () => {
    const out = build([{ id: 'wr-char-hero', name: 'Hero', role: 'protagonist' }]);
    expect(out.cast.coverage[0].staged).toBe(true);
    // Being on the page does not close an authored gap.
    expect(out.cast.findings.length).toBeGreaterThan(0);
  });

  it('marks the staging join stale when the script no longer matches the draft', () => {
    const fresh = build([hero()]);
    expect(fresh.cast.staging).toMatchObject({ available: true, stale: false });
    const drifted = buildSyncedReview({
      manifest: makeManifest({ contentHash: 'hash-new' }),
      body: BODY,
      scriptAnalysis: makeScriptAnalysis(),
      characters: [hero()],
    });
    expect(drifted.cast.staging.stale).toBe(true);
  });

  it('reports an empty bible as unavailable rather than as a clean cast', () => {
    const out = build([]);
    expect(out.cast.available).toBe(false);
    expect(out.cast.castCount).toBe(0);
    expect(out.cast.passed).toBe(false);
  });

  it('does not stage anybody when no script analysis has run', () => {
    const out = build([hero()], { scriptAnalysis: null });
    expect(out.cast.staging).toMatchObject({ available: false, stagedCount: 0 });
    expect(out.cast.coverage[0].staged).toBe(false);
  });
});
