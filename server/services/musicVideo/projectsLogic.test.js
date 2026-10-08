import { describe, it, expect } from 'vitest';
import {
  buildProjectRecord,
  cloneProjectRecord,
  applyProjectPatch,
  setAudioAnalysis,
  setMidiTranscription,
  addScene,
  addScenes,
  applySceneUpdate,
  removeScene,
  reorderScenes,
  mirrorStatus,
  sanitizeProjectForSync,
  mergeProjectRecord,
} from './projectsLogic.js';

const baseProject = () => buildProjectRecord({ name: 'Test MV' }, { id: 'mv-1', now: '2026-01-01T00:00:00.000Z' });

describe('buildProjectRecord', () => {
  it('builds a draft director project with sensible defaults', () => {
    const p = buildProjectRecord({ name: 'Neon Nights', trackId: 'track-9' }, { id: 'mv-x', now: '2026-01-01T00:00:00.000Z' });
    expect(p).toMatchObject({
      id: 'mv-x', name: 'Neon Nights', status: 'draft', mode: 'director',
      version: 1, parentProjectId: null, rootProjectId: null,
      trackId: 'track-9', uploadedAudioFilename: null, concept: null,
      videoSettings: { backend: 'local', modelId: null, grokDuration: 10 },
      audioAnalysis: null, midiTranscription: null, scenes: [], renderHistoryId: null,
      deleted: false, deletedAt: null,
    });
    expect(p.createdAt).toBe(p.updatedAt);
  });

  it('honors an explicit autonomous mode and concept', () => {
    const p = buildProjectRecord({ name: 'A', mode: 'autonomous', concept: { prompt: 'noir' } }, { id: 'mv-2', now: 'n' });
    expect(p.mode).toBe('autonomous');
    expect(p.concept).toEqual({ prompt: 'noir' });
  });

  it('persists the image render pin only when set (#3231 Phase 4)', () => {
    const pinned = buildProjectRecord(
      { name: 'A', imageMode: 'codex', imageModelId: 'example-model' },
      { id: 'mv-3', now: 'n' },
    );
    expect(pinned.imageMode).toBe('codex');
    expect(pinned.imageModelId).toBe('example-model');
    // No pin → the keys are absent entirely, keeping the on-disk shape
    // byte-stable for existing records.
    const unpinned = buildProjectRecord({ name: 'B' }, { id: 'mv-4', now: 'n' });
    expect('imageMode' in unpinned).toBe(false);
    expect('imageModelId' in unpinned).toBe(false);
    // The 'auto' sentinel and blanks collapse to no pin.
    const auto = buildProjectRecord({ name: 'C', imageMode: 'auto', imageModelId: '' }, { id: 'mv-5', now: 'n' });
    expect('imageMode' in auto).toBe(false);
    expect('imageModelId' in auto).toBe(false);
  });

  it('a patch sets and clears the image render pin (#3231 Phase 4)', () => {
    const p = baseProject();
    const pinned = applyProjectPatch(p, { imageMode: 'agy', imageModelId: 'example-model' });
    expect(pinned.imageMode).toBe('agy');
    expect(pinned.imageModelId).toBe('example-model');
    // Key-present-with-null is the intentional clear (absent-vs-empty rule).
    const cleared = applyProjectPatch(pinned, { imageMode: null, imageModelId: null });
    expect(cleared.imageMode).toBeNull();
    expect(cleared.imageModelId).toBeNull();
  });
});

describe('cloneProjectRecord', () => {
  it('creates an editable next version with fresh scene ids and reusable media', () => {
    const source = {
      ...baseProject(),
      status: 'complete',
      renderHistoryId: 'final-1',
      composition: { mode: 'composed', grade: { preset: 'neutral', sections: [{ sceneId: 'scene-old', preset: 'teal-night' }] } },
      audioAnalysis: {
        bpm: 120, beats: [0], downbeats: [0],
        sections: [{ label: 'S', startSec: 0, endSec: 5 }],
        durationSec: 5,
      },
      scenes: [{
        sceneId: 'scene-old',
        order: 0,
        prompt: 'Tracking shot',
        referenceImageId: 'frame.png',
        videoHistoryId: 'clip-1',
      }],
    };

    const clone = cloneProjectRecord(source, {
      id: 'mv-2',
      now: '2026-01-02T00:00:00.000Z',
    });

    expect(clone).toMatchObject({
      id: 'mv-2',
      name: 'Test MV v2',
      version: 2,
      parentProjectId: 'mv-1',
      rootProjectId: 'mv-1',
      status: 'ready',
      renderHistoryId: null,
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    expect(clone.scenes[0]).toMatchObject({
      order: 0,
      referenceImageId: 'frame.png',
      videoHistoryId: 'clip-1',
    });
    expect(clone.scenes[0].sceneId).not.toBe('scene-old');
    expect(clone.composition.grade.sections).toEqual([{ sceneId: clone.scenes[0].sceneId, preset: 'teal-night' }]);
    expect(source.composition.grade.sections[0].sceneId).toBe('scene-old');
    expect(source.scenes[0].sceneId).toBe('scene-old');
    // A pre-#8965 scene's selections become takes on the clone, so the new
    // version's candidate list is never missing what it already shows.
    expect(clone.scenes[0].takes.map((t) => [t.kind, t.assetId, t.source])).toEqual([
      ['image', 'frame.png', 'legacy'],
      ['video', 'clip-1', 'legacy'],
    ]);
  });

  it('starts a clone without the source\'s finished-outside marker, since the new version is made here', () => {
    const clone = cloneProjectRecord({ ...baseProject(), renderHistoryId: 'final-1', finishedOutside: { markedAt: '2026-01-01T00:00:00.000Z' } },
      { id: 'mv-2', now: '2026-01-02T00:00:00.000Z' });
    expect(clone.finishedOutside).toBeNull();
    expect(cloneProjectRecord(baseProject(), { id: 'mv-3', now: '2026-01-02T00:00:00.000Z' })).not.toHaveProperty('finishedOutside');
  });

  it('starts a clone with no auto-review runs, and adds no field when the source has none', () => {
    const withRuns = cloneProjectRecord({
      ...baseProject(),
      autoReviews: [{ id: 'ar-1', status: 'running', attempts: [{ revisionId: 'rev-1' }] }, { id: 'ar-2', status: 'complete' }],
    }, { id: 'mv-2', now: '2026-01-02T00:00:00.000Z' });
    expect(withRuns.autoReviews).toEqual([]);
    const without = cloneProjectRecord(baseProject(), { id: 'mv-3', now: '2026-01-02T00:00:00.000Z' });
    expect(without).not.toHaveProperty('autoReviews');
  });

  it('carries development artifacts and the Cast & Sets result to a clone, but not its dispatch pin or production link', () => {
    const artifact = { id: 'mvd-1', kind: 'cast-sets', title: 'Sheet', status: 'approved', version: 2, file: 'music-video/mv-1/dev/mvd-1/v2.html', versions: [], notes: [] };
    const clone = cloneProjectRecord({
      ...baseProject(),
      devArtifacts: [artifact],
      castAndSets: { status: 'imaging', revision: 2, processId: 'proc-a', productionRunId: 'mvpr-1', artifactId: 'mvd-1', images: { character: { status: 'done', imageId: 'c.png' } } },
    }, { id: 'mv-2', now: '2026-01-02T00:00:00.000Z' });
    expect(clone.devArtifacts).toEqual([artifact]);
    expect(clone.castAndSets).toMatchObject({ status: 'imaging', revision: 2, processId: null, productionRunId: null, artifactId: 'mvd-1' });
    expect(cloneProjectRecord(baseProject(), { id: 'mv-3', now: '2026-01-02T00:00:00.000Z' })).not.toHaveProperty('castAndSets');
  });

  it('can fork the board without carrying generated media', () => {
    const source = {
      ...baseProject(),
      version: 2,
      rootProjectId: 'mv-root',
      scenes: [{ sceneId: 'old', order: 0, referenceImageId: 'frame.png', videoHistoryId: 'clip-1' }],
    };
    const clone = cloneProjectRecord(source, {
      id: 'mv-3',
      now: '2026-01-03T00:00:00.000Z',
      includeGeneratedMedia: false,
    });

    expect(clone).toMatchObject({
      version: 3,
      parentProjectId: 'mv-1',
      rootProjectId: 'mv-root',
      name: 'Test MV v3',
    });
    expect(clone.scenes[0]).toMatchObject({ referenceImageId: null, videoHistoryId: null, takes: [] });
  });
});

describe('applyProjectPatch', () => {
  it('stores an explicit sound-design bed (level clamped), clears it with null, and never lets the song be its own bed (#8988)', () => {
    const withSong = applyProjectPatch(baseProject(), { trackId: 'trk-song' });
    const bedded = applyProjectPatch(withSong, { soundBed: { trackId: 'trk-rain', volume: 0.333 } });
    expect(bedded.soundBed).toEqual({ trackId: 'trk-rain', volume: 0.33 });
    expect(applyProjectPatch(bedded, { soundBed: null }).soundBed).toBeNull();
    expect(() => applyProjectPatch(withSong, { soundBed: { trackId: 'trk-song' } })).toThrow(expect.objectContaining({ code: 'SOUND_BED_IS_MASTER' }));
  });

  it('merges fields and bumps updatedAt', () => {
    const next = applyProjectPatch(baseProject(), { name: 'Renamed', trackId: 't2' });
    expect(next.name).toBe('Renamed');
    expect(next.trackId).toBe('t2');
    expect(next.updatedAt).not.toBe('2026-01-01T00:00:00.000Z');
  });

  it('rejects an invalid status', () => {
    expect(() => applyProjectPatch(baseProject(), { status: 'bogus' })).toThrow(/Invalid status/);
  });

  it('accepts a valid status', () => {
    expect(applyProjectPatch(baseProject(), { status: 'ready' }).status).toBe('ready');
  });

  it('clears cached audioAnalysis when trackId changes to a different track (#1945)', () => {
    const analyzed = setAudioAnalysis({ ...baseProject(), trackId: 't1' }, {
      bpm: 120, beats: [0, 0.5], downbeats: [0], sections: [{ label: 'Section 1', startSec: 0, endSec: 1 }], durationSec: 1,
    });
    expect(analyzed.audioAnalysis).not.toBeNull();
    const next = applyProjectPatch(analyzed, { trackId: 't2' });
    expect(next.trackId).toBe('t2');
    expect(next.audioAnalysis).toBeNull();
  });

  it('clears the MIDI transcription when the audio source changes (it was transcribed from the OLD track)', () => {
    const withMidi = setMidiTranscription({ ...baseProject(), trackId: 't1' },
      { filename: 'song.mid', model: 'medium', createdAt: '2026-01-02T00:00:00.000Z' });
    expect(withMidi.midiTranscription).not.toBeNull();
    const next = applyProjectPatch(withMidi, { trackId: 't2' });
    expect(next.midiTranscription).toBeNull();
    // Non-audio patches leave it intact.
    const renamed = applyProjectPatch(withMidi, { name: 'Renamed' });
    expect(renamed.midiTranscription).toEqual(withMidi.midiTranscription);
  });

  it('leaves audioAnalysis intact when trackId is patched to the SAME value', () => {
    const analyzed = setAudioAnalysis({ ...baseProject(), trackId: 't1' }, {
      bpm: 120, beats: [0], downbeats: [0], sections: [{ label: 'S', startSec: 0, endSec: 1 }], durationSec: 1,
    });
    const next = applyProjectPatch(analyzed, { trackId: 't1', name: 'Renamed' });
    expect(next.audioAnalysis).not.toBeNull();
  });

  it('leaves audioAnalysis intact for a patch that does not touch the track', () => {
    const analyzed = setAudioAnalysis({ ...baseProject(), trackId: 't1' }, {
      bpm: 120, beats: [0], downbeats: [0], sections: [{ label: 'S', startSec: 0, endSec: 1 }], durationSec: 1,
    });
    const next = applyProjectPatch(analyzed, { name: 'Renamed' });
    expect(next.audioAnalysis).not.toBeNull();
  });

  it('clears audioAnalysis when uploadedAudioFilename changes to a different file', () => {
    const analyzed = setAudioAnalysis({ ...baseProject(), uploadedAudioFilename: 'a.mp3' }, {
      bpm: 100, beats: [0], downbeats: [0], sections: [{ label: 'S', startSec: 0, endSec: 1 }], durationSec: 1,
    });
    const next = applyProjectPatch(analyzed, { uploadedAudioFilename: 'b.mp3' });
    expect(next.audioAnalysis).toBeNull();
  });

  it('clears beatAligned on scenes when the track changes — their bounds were snapped to the OLD beat grid', () => {
    const withScenes = {
      ...baseProject(),
      trackId: 't1',
      scenes: [
        { sceneId: 's1', order: 0, startSec: 1, endSec: 2, beatAligned: true },
        { sceneId: 's2', order: 1, startSec: 3, endSec: 4, beatAligned: false, sectionIndex: 0 },
      ],
    };
    const next = applyProjectPatch(withScenes, { trackId: 't2' });
    expect(next.scenes[0]).toMatchObject({ beatAligned: false, startSec: 1, endSec: 2 });
    expect(next.scenes[1]).toMatchObject({ beatAligned: false, sectionIndex: null, startSec: 3, endSec: 4 });
  });

  it('regresses status to draft on track change since the cleared analysis must be redone', () => {
    const analyzed = setAudioAnalysis({ ...baseProject(), trackId: 't1', status: 'ready' }, {
      bpm: 120, beats: [0], downbeats: [0], sections: [{ label: 'S', startSec: 0, endSec: 1 }], durationSec: 1,
    });
    expect(analyzed.status).toBe('ready');
    const next = applyProjectPatch(analyzed, { trackId: 't2' });
    expect(next.status).toBe('draft');
    expect(next.audioAnalysis).toBeNull();
  });

  it('honors an explicit status in the same track-change patch instead of regressing', () => {
    const analyzed = setAudioAnalysis({ ...baseProject(), trackId: 't1', status: 'ready' }, {
      bpm: 120, beats: [0], downbeats: [0], sections: [{ label: 'S', startSec: 0, endSec: 1 }], durationSec: 1,
    });
    const next = applyProjectPatch(analyzed, { trackId: 't2', status: 'analyzed' });
    expect(next.status).toBe('analyzed');
  });

  it('leaves status untouched on a track change when the project is still a draft', () => {
    const next = applyProjectPatch({ ...baseProject(), trackId: 't1', status: 'draft' }, { trackId: 't2' });
    expect(next.status).toBe('draft');
  });

  it('leaves scene beatAligned flags untouched when the track does not change', () => {
    const withScenes = {
      ...baseProject(),
      trackId: 't1',
      scenes: [{ sceneId: 's1', order: 0, startSec: 1, endSec: 2, beatAligned: true }],
    };
    const next = applyProjectPatch(withScenes, { name: 'Renamed' });
    expect(next.scenes[0].beatAligned).toBe(true);
  });

  it('merges a concept patch into the existing concept instead of replacing it (#3168)', () => {
    const withConcept = { ...baseProject(), concept: { prompt: 'A road trip', style: 'Cyberpunk anime' } };
    const next = applyProjectPatch(withConcept, { concept: { style: 'Watercolor noir' } });
    expect(next.concept).toEqual({ prompt: 'A road trip', style: 'Watercolor noir' });
  });

  it('sets a concept sub-field on a project with no existing concept', () => {
    const next = applyProjectPatch(baseProject(), { concept: { prompt: 'Underwater festival' } });
    expect(next.concept).toEqual({ prompt: 'Underwater festival' });
  });

  it('clears the concept outright when the patch sets it to null', () => {
    const withConcept = { ...baseProject(), concept: { prompt: 'A road trip', style: 'Cyberpunk anime' } };
    const next = applyProjectPatch(withConcept, { concept: null });
    expect(next.concept).toBeNull();
  });

  it('merges a visualSpec patch per sub-field and gives every reference a stable id (#8965)', () => {
    const first = applyProjectPatch(baseProject(), {
      visualSpec: { palette: ['#AABBCC'], references: [{ imageId: 'mood.png', condition: true }] },
    });
    const [ref] = first.visualSpec.references;
    expect(ref).toMatchObject({ imageId: 'mood.png', role: 'mood', condition: true, label: '' });
    expect(ref.id).toMatch(/^mvr-/);
    expect(first.visualSpec.palette).toEqual(['#aabbcc']);
    // A later edit of one sub-field keeps the others (and the minted id).
    const second = applyProjectPatch(first, { visualSpec: { cameraRules: 'handheld only' } });
    expect(second.visualSpec).toMatchObject({ palette: ['#aabbcc'], cameraRules: 'handheld only' });
    expect(second.visualSpec.references[0].id).toBe(ref.id);
  });

  it('stores the automation brief only when set, merges patches per sub-field, and clears with null', () => {
    expect('automation' in baseProject()).toBe(false);
    const created = buildProjectRecord({
      name: 'Auto', mode: 'autonomous',
      automation: { tools: ['video:fal', 'image:codex', 'video:fal'], guidance: 'surreal', budgetUsd: 25 },
    }, { id: 'mv-a', now: 'n' });
    // De-duplicated, in catalog order (image before video).
    // The Cast & Sets check-in gate defaults to review.
    expect(created.automation).toEqual({ tools: ['image:codex', 'video:fal'], guidance: 'surreal', budgetUsd: 25, checkins: { castAndSets: 'review' } });
    const auto = applyProjectPatch(created, { automation: { checkins: { castAndSets: 'auto' } } });
    expect(auto.automation.checkins).toEqual({ castAndSets: 'auto' });
    const edited = applyProjectPatch(auto, { automation: { guidance: 'darker' } });
    // A guidance edit keeps the gate the director chose.
    expect(edited.automation).toEqual({ tools: ['image:codex', 'video:fal'], guidance: 'darker', budgetUsd: 25, checkins: { castAndSets: 'auto' } });
    expect(applyProjectPatch(edited, { automation: { budgetUsd: null } }).automation.budgetUsd).toBeNull();
    expect(applyProjectPatch(edited, { automation: null }).automation).toBeNull();
  });

  it('keeps the brief LLM pin through other edits, clears it with null, never takes a patch-written route, and loads a pre-#9545 record unchanged', () => {
    const llm = { providerId: 'claude-tui', model: 'opus', effort: 'high' };
    const created = buildProjectRecord({ name: 'Auto', mode: 'autonomous', automation: { tools: ['image:codex'], llm } }, { id: 'mv-a', now: 'n' });
    expect(created.automation.llm).toEqual(llm);

    // Another sub-field edit keeps it; a route a patch tries to smuggle in is dropped.
    const edited = applyProjectPatch(created, { automation: { guidance: 'darker', routes: { plan: { providerId: 'forged' } } } });
    expect(edited.automation.llm).toEqual(llm);
    expect(edited.automation.routes).toBeUndefined();

    // The server-written route survives later brief edits.
    const withRoute = { ...edited, automation: { ...edited.automation, routes: { plan: { providerId: 'claude-tui', transport: 'tui', source: 'brief' } } } };
    expect(applyProjectPatch(withRoute, { automation: { budgetUsd: 3 } }).automation.routes.plan).toMatchObject({ providerId: 'claude-tui', transport: 'tui' });

    // null returns to Auto; a model/effort without a provider is dropped.
    expect('llm' in applyProjectPatch(edited, { automation: { llm: null } }).automation).toBe(false);
    expect('llm' in applyProjectPatch(edited, { automation: { llm: { model: 'orphan', effort: 'high' } } }).automation).toBe(false);

    // A record saved before the pin existed carries neither field.
    const legacy = applyProjectPatch({ ...created, automation: { tools: ['image:codex'], guidance: 'g', budgetUsd: null, checkins: { castAndSets: 'review' } } }, { automation: { guidance: 'h' } });
    expect(legacy.automation).toEqual({ tools: ['image:codex'], guidance: 'h', budgetUsd: null, checkins: { castAndSets: 'review' } });
  });

  it('merges per-stage LLM pins stage by stage: absent keeps, null clears one stage, null for the whole map clears them all', () => {
    const lyrics = { providerId: 'local-llm', model: 'small', effort: null };
    const plan = { providerId: 'claude-tui', model: 'opus', effort: 'high' };
    const created = buildProjectRecord({ name: 'Auto', mode: 'autonomous', automation: { tools: ['image:codex'], llmStages: { lyrics, bogus: plan, plan: { model: 'orphan' } } } }, { id: 'mv-a', now: 'n' });
    // Unknown stages and a pin with no provider are dropped.
    expect(created.automation.llmStages).toEqual({ lyrics });

    const added = applyProjectPatch(created, { automation: { llmStages: { plan } } });
    expect(added.automation.llmStages).toEqual({ lyrics, plan });
    // An unrelated brief edit keeps every stage pin.
    expect(applyProjectPatch(added, { automation: { guidance: 'darker' } }).automation.llmStages).toEqual({ lyrics, plan });

    expect(applyProjectPatch(added, { automation: { llmStages: { lyrics: null } } }).automation.llmStages).toEqual({ plan });
    // Clearing the last stage drops the field rather than storing an empty map.
    expect('llmStages' in applyProjectPatch(created, { automation: { llmStages: { lyrics: null } } }).automation).toBe(false);
    expect('llmStages' in applyProjectPatch(added, { automation: { llmStages: null } }).automation).toBe(false);
  });

  it('persists explicit renderer settings and merges later partial changes', () => {
    const project = buildProjectRecord({
      name: 'A',
      videoSettings: { backend: 'grok', grokDuration: 6 },
    }, { id: 'mv-2', now: 'n' });
    expect(project.videoSettings).toEqual({
      backend: 'grok',
      modelId: null,
      grokDuration: 6,
      falDuration: null,
      falModelId: null,
      falResolution: null,
      falLipSyncResolution: null,
      generationMode: 'image',
      audioReactiveLora: null,
      audioReactiveScale: 1.2,
    });

    const next = applyProjectPatch(project, {
      videoSettings: { backend: 'local', modelId: 'ltx23_distilled_q4' },
    });
    expect(next.videoSettings).toEqual({
      backend: 'local',
      modelId: 'ltx23_distilled_q4',
      grokDuration: 6,
      falDuration: null,
      falModelId: null,
      falResolution: null,
      falLipSyncResolution: null,
      generationMode: 'image',
      audioReactiveLora: null,
      audioReactiveScale: 1.2,
    });
  });
});

describe('setAudioAnalysis', () => {
  const analysis = { bpm: 120, beats: [0, 0.5], downbeats: [0], sections: [{ label: 'Section 1', startSec: 0, endSec: 1 }], durationSec: 1 };

  it('caches the analysis and flips a draft to analyzed', () => {
    const next = setAudioAnalysis(baseProject(), analysis);
    expect(next.audioAnalysis).toEqual(analysis);
    expect(next.status).toBe('analyzed');
  });

  it('keeps a feature track through validation, drops it with the audio source, and leaves legacy analyses without one (#9073)', () => {
    const features = {
      envelopes: { fps: 30, rms: [0, 1], low: [0, 1], mid: [0, 1], high: [0, 1] },
      onsets: { low: [0.5], mid: [], high: [] },
      truncatedAtSec: null,
    };
    const withFeatures = setAudioAnalysis({ ...baseProject(), trackId: 't1' }, { ...analysis, version: 2, features });
    expect(withFeatures.audioAnalysis.features).toEqual(features);
    expect(setAudioAnalysis(baseProject(), analysis).audioAnalysis.features).toBeUndefined();
    expect(() => setAudioAnalysis(baseProject(), { ...analysis, features: { ...features, envelopes: { ...features.envelopes, low: [2] } } })).toThrow();
    expect(applyProjectPatch(withFeatures, { trackId: 't2' }).audioAnalysis).toBeNull();
  });

  it('does not regress a later lifecycle status', () => {
    const ready = { ...baseProject(), status: 'ready' };
    expect(setAudioAnalysis(ready, analysis).status).toBe('ready');
  });
});

describe('setMidiTranscription', () => {
  it('caches the validated pointer and leaves the lifecycle status alone', () => {
    const midi = { filename: 'song.mid', model: 'medium', createdAt: '2026-01-02T00:00:00.000Z' };
    const next = setMidiTranscription(baseProject(), midi);
    expect(next.midiTranscription).toEqual(midi);
    expect(next.status).toBe('draft');
    expect(next.updatedAt).not.toBe('2026-01-01T00:00:00.000Z');
  });

  it('rejects a malformed pointer', () => {
    expect(() => setMidiTranscription(baseProject(), { filename: '' })).toThrow();
    expect(() => setMidiTranscription(baseProject(), { filename: 'a.mid', extra: true })).toThrow();
  });
});

describe('scene board operations', () => {
  it('adds scenes with incrementing order and unique ids', () => {
    const { project: p1, scene: s1 } = addScene(baseProject(), { prompt: 'wide shot' });
    const { project: p2, scene: s2 } = addScene(p1, { prompt: 'close up' });
    expect(s1.order).toBe(0);
    expect(s2.order).toBe(1);
    expect(s1.sceneId).not.toBe(s2.sceneId);
    expect(p2.scenes).toHaveLength(2);
    expect(s1.prompt).toBe('wide shot');
    expect(s1.referenceImageId).toBeNull();
  });

  it('rejects a scene whose endSec precedes startSec', () => {
    expect(() => addScene(baseProject(), { startSec: 10, endSec: 5 })).toThrow(/Scene validation failed/);
  });

  it('addScenes bulk-appends in one pass with incrementing order (the autonomous planner, #1855)', () => {
    const { project, scenes } = addScenes(baseProject(), [
      { label: 'Intro', startSec: 0, endSec: 10 },
      { label: 'Drop', startSec: 10, endSec: 18 },
    ]);
    expect(scenes).toHaveLength(2);
    expect(scenes.map((s) => s.order)).toEqual([0, 1]);
    expect(scenes[0].sceneId).not.toBe(scenes[1].sceneId);
    expect(project.scenes).toHaveLength(2);
  });

  it('addScenes continues ordering after existing scenes', () => {
    const { project: seeded } = addScene(baseProject(), { prompt: 'existing' });
    const { scenes } = addScenes(seeded, [{ label: 'Next' }]);
    expect(scenes[0].order).toBe(1);
  });

  it('addScenes rejects the whole batch if any scene is invalid', () => {
    expect(() => addScenes(baseProject(), [
      { label: 'ok', startSec: 0, endSec: 5 },
      { label: 'bad', startSec: 10, endSec: 5 },
    ])).toThrow(/Scene validation failed/);
  });

  it('addScenes treats a non-array input as empty', () => {
    const { project, scenes } = addScenes(baseProject(), null);
    expect(scenes).toEqual([]);
    expect(project.scenes).toEqual([]);
  });

  it('updates a scene by id', () => {
    const { project, scene } = addScene(baseProject(), { prompt: 'a' });
    const { updated } = applySceneUpdate(project, scene.sceneId, { prompt: 'b', referenceImageId: 'img-1' });
    expect(updated.prompt).toBe('b');
    expect(updated.referenceImageId).toBe('img-1');
  });

  it('404s updating an unknown scene', () => {
    expect(() => applySceneUpdate(baseProject(), 'nope', { prompt: 'x' })).toThrow(/Scene not found/);
  });

  it('clears a previously-set scene time when patched with null', () => {
    const { project, scene } = addScene(baseProject(), { startSec: 5, endSec: 10 });
    const { updated } = applySceneUpdate(project, scene.sceneId, { startSec: null });
    expect(updated.startSec).toBeNull();
    expect(updated.endSec).toBe(10);
  });

  it('rejects a patch whose merged endSec precedes the existing startSec', () => {
    const { project, scene } = addScene(baseProject(), { startSec: 10, endSec: 20 });
    expect(() => applySceneUpdate(project, scene.sceneId, { endSec: 5 })).toThrow(/endSec must be >= startSec/);
  });

  it('removes a scene and re-sequences order', () => {
    let p = baseProject();
    const ids = [];
    for (const prompt of ['a', 'b', 'c']) { const r = addScene(p, { prompt }); p = r.project; ids.push(r.scene.sceneId); }
    const next = removeScene(p, ids[0]);
    expect(next.scenes).toHaveLength(2);
    expect(next.scenes.map((s) => s.order)).toEqual([0, 1]);
    expect(next.scenes.map((s) => s.sceneId)).toEqual([ids[1], ids[2]]);
  });

  it('404s removing an unknown scene', () => {
    expect(() => removeScene(baseProject(), 'nope')).toThrow(/Scene not found/);
  });

  it('reorders scenes to the given id order and reassigns order', () => {
    let p = baseProject();
    const ids = [];
    for (const prompt of ['a', 'b', 'c']) { const r = addScene(p, { prompt }); p = r.project; ids.push(r.scene.sceneId); }
    const next = reorderScenes(p, [ids[2], ids[0], ids[1]]);
    expect(next.scenes.map((s) => s.sceneId)).toEqual([ids[2], ids[0], ids[1]]);
    expect(next.scenes.map((s) => s.order)).toEqual([0, 1, 2]);
  });

  it('defaults a new scene to its footage and persists a chosen still or card layer (#8985)', () => {
    const { project, scene } = addScene(baseProject(), { prompt: 'a' });
    expect(scene).toMatchObject({ visualLayer: 'footage', stillMove: 'hold', cardText: null, cardColor: null });
    const { updated } = applySceneUpdate(project, scene.sceneId, { visualLayer: 'card', cardText: 'Verse two', cardColor: '#112233' });
    expect(updated).toMatchObject({ visualLayer: 'card', cardText: 'Verse two', cardColor: '#112233' });
    expect(() => applySceneUpdate(project, scene.sceneId, { visualLayer: 'hologram' })).toThrow();
    expect(() => applySceneUpdate(project, scene.sceneId, { cardColor: 'red' })).toThrow();
  });

  it('persists a shot\'s lyric-type zone and role and refuses unknown ones (#10583)', () => {
    const { project, scene } = addScene(baseProject(), { prompt: 'a' });
    const { updated } = applySceneUpdate(project, scene.sceneId, { textZone: 'none', lyricRole: 'hook' });
    expect(updated).toMatchObject({ textZone: 'none', lyricRole: 'hook' });
    expect(applySceneUpdate(project, scene.sceneId, { textZone: null }).updated.textZone).toBeNull();
    expect(() => applySceneUpdate(project, scene.sceneId, { textZone: 'middle' })).toThrow();
    expect(() => applySceneUpdate(project, scene.sceneId, { lyricRole: 'karaoke' })).toThrow();
  });

  it('rejects a reorder that is not an exact permutation', () => {
    let p = baseProject();
    const r = addScene(p, { prompt: 'a' }); p = r.project;
    expect(() => reorderScenes(p, [r.scene.sceneId, 'extra'])).toThrow(/each existing scene id exactly once/);
    expect(() => reorderScenes(p, [])).toThrow(/each existing scene id exactly once/);
  });
});

describe('mirrorStatus', () => {
  it('bounds and defaults the status column value', () => {
    expect(mirrorStatus('rendering')).toBe('rendering');
    expect(mirrorStatus('')).toBe('draft');
    expect(mirrorStatus(null)).toBe('draft');
    expect(mirrorStatus('x'.repeat(40))).toHaveLength(32);
  });
});

describe('sanitizeProjectForSync (#1770 federation)', () => {
  it('rejects non-objects, arrays, and id-less records', () => {
    expect(sanitizeProjectForSync(null)).toBeNull();
    expect(sanitizeProjectForSync('x')).toBeNull();
    expect(sanitizeProjectForSync([])).toBeNull();
    expect(sanitizeProjectForSync({})).toBeNull();
    expect(sanitizeProjectForSync({ id: '' })).toBeNull();
  });

  it('normalizes timestamps and the soft-delete pair', () => {
    const out = sanitizeProjectForSync({ id: 'mv-1', name: 'A' });
    expect(out.id).toBe('mv-1');
    expect(typeof out.createdAt).toBe('string');
    expect(out.updatedAt).toBe(out.createdAt); // defaults updatedAt to createdAt
    expect(out.deleted).toBe(false);
    expect(out.deletedAt).toBeNull();
  });

  it('drops a stray deletedAt when deleted is false', () => {
    const out = sanitizeProjectForSync({ id: 'mv-1', updatedAt: 'u', deleted: false, deletedAt: '2026-01-01T00:00:00Z' });
    expect(out.deletedAt).toBeNull();
  });

  it('keeps a tombstone with deleted=true + deletedAt', () => {
    const out = sanitizeProjectForSync({ id: 'mv-1', updatedAt: 'u', deleted: true, deletedAt: '2026-01-01T00:00:00Z' });
    expect(out.deleted).toBe(true);
    expect(out.deletedAt).toBe('2026-01-01T00:00:00Z');
  });
});

describe('mergeProjectRecord (#1770 LWW)', () => {
  it('drops a malformed remote', () => {
    expect(mergeProjectRecord(null, {}).next).toBeNull();
  });

  it('inserts when there is no local copy', () => {
    const r = mergeProjectRecord(null, { id: 'mv-1', updatedAt: '2026-01-02T00:00:00Z', name: 'X' });
    expect(r.inserted).toBe(true);
    expect(r.remoteWins).toBe(true);
    expect(r.next.name).toBe('X');
  });

  it('strips render pins sent by a legacy peer before inserting (#3245)', () => {
    const { next } = mergeProjectRecord(null, {
      id: 'mv-1',
      updatedAt: '2026-01-02T00:00:00Z',
      imageMode: 'grok',
      imageModelId: 'foreign-image-model',
      videoSettings: { backend: 'grok', modelId: 'shared-video-model' },
    });

    expect(next).not.toHaveProperty('imageMode');
    expect(next).not.toHaveProperty('imageModelId');
    expect(next.videoSettings).toEqual({ modelId: 'shared-video-model' });
  });

  it('keeps the production-run checkpoint install-local: never on the wire, never taken from a peer, kept over a newer remote (#9066)', async () => {
    const { sanitizeRecordForWire } = await import('../../lib/syncWire.js');
    const runs = [{ id: 'mvpr-local', status: 'running', pool: [{ kind: 'image', mode: 'codex', model: null }] }];
    const local = { id: 'mv-1', updatedAt: '2026-01-01T00:00:00Z', name: 'local', productionRuns: runs };
    expect(sanitizeRecordForWire('musicVideoProject', local)).not.toHaveProperty('productionRuns');

    const foreign = [{ id: 'mvpr-foreign', status: 'running' }];
    expect(mergeProjectRecord(null, { id: 'mv-2', updatedAt: '2026-01-02T00:00:00Z', productionRuns: foreign }).next)
      .not.toHaveProperty('productionRuns');
    const { next } = mergeProjectRecord(local, { id: 'mv-1', updatedAt: '2026-01-05T00:00:00Z', name: 'remote edit', productionRuns: foreign });
    expect(next.name).toBe('remote edit');
    expect(next.productionRuns).toEqual(runs);
  });

  it('keeps development artifacts and the Cast & Sets checkpoint install-local (their files and jobs live here)', async () => {
    const { sanitizeRecordForWire } = await import('../../lib/syncWire.js');
    const devArtifacts = [{ id: 'mvd-1', kind: 'cast-sets', file: 'music-video/mv-1/dev/mvd-1/v1.html' }];
    const castAndSets = { status: 'review', processId: 'proc-local' };
    const local = { id: 'mv-1', updatedAt: '2026-01-01T00:00:00Z', name: 'local', devArtifacts, castAndSets };
    const wire = sanitizeRecordForWire('musicVideoProject', local);
    expect(wire).not.toHaveProperty('devArtifacts');
    expect(wire).not.toHaveProperty('castAndSets');

    const foreign = { devArtifacts: [{ id: 'mvd-foreign' }], castAndSets: { status: 'imaging' } };
    const inserted = mergeProjectRecord(null, { id: 'mv-2', updatedAt: '2026-01-02T00:00:00Z', ...foreign }).next;
    expect(inserted).not.toHaveProperty('devArtifacts');
    expect(inserted).not.toHaveProperty('castAndSets');
    const { next } = mergeProjectRecord(local, { id: 'mv-1', updatedAt: '2026-01-05T00:00:00Z', name: 'remote edit', ...foreign });
    expect(next.name).toBe('remote edit');
    expect(next.devArtifacts).toEqual(devArtifacts);
    expect(next.castAndSets).toEqual(castAndSets);
  });

  it('remote with a newer updatedAt wins', () => {
    const local = { id: 'mv-1', updatedAt: '2026-01-01T00:00:00Z', name: 'old' };
    const remote = { id: 'mv-1', updatedAt: '2026-01-05T00:00:00Z', name: 'new' };
    const r = mergeProjectRecord(local, remote);
    expect(r.remoteWins).toBe(true);
    expect(r.changed).toBe(true);
    expect(r.next.name).toBe('new');
  });

  it('preserves local render pins when a newer remote edit wins (#3245)', () => {
    const local = {
      id: 'mv-1',
      updatedAt: '2026-01-01T00:00:00Z',
      name: 'local',
      renderError: 'Example local document failure',
      imageMode: 'codex',
      imageModelId: 'example-image-model',
      videoSettings: { backend: 'local', modelId: 'local-model', grokDuration: 5 },
    };
    const remote = {
      id: 'mv-1',
      updatedAt: '2026-01-05T00:00:00Z',
      name: 'remote edit',
      renderError: 'Peer failure must stay on peer',
      videoSettings: { modelId: 'shared-model', grokDuration: 10 },
    };

    const r = mergeProjectRecord(local, remote);

    expect(r.remoteWins).toBe(true);
    expect(r.next.name).toBe('remote edit');
    expect(r.next.renderError).toBe('Example local document failure');
    expect(r.next.imageMode).toBe('codex');
    expect(r.next.imageModelId).toBe('example-image-model');
    expect(r.next.videoSettings).toEqual({
      modelId: 'shared-model',
      grokDuration: 10,
      backend: 'local',
    });
  });

  it('keeps absent local image pins absent while preserving a local video backend', () => {
    const local = {
      id: 'mv-1',
      updatedAt: '2026-01-01T00:00:00Z',
      videoSettings: { backend: 'local' },
    };
    const remote = {
      id: 'mv-1',
      updatedAt: '2026-01-05T00:00:00Z',
      imageMode: 'grok',
      imageModelId: 'foreign-image-model',
      videoSettings: { backend: 'grok', modelId: 'shared-model' },
    };

    const { next } = mergeProjectRecord(local, remote);

    expect(next).not.toHaveProperty('imageMode');
    expect(next).not.toHaveProperty('imageModelId');
    expect(next.videoSettings).toEqual({ modelId: 'shared-model', backend: 'local' });
  });

  it('local with a newer updatedAt wins (no change applied)', () => {
    const local = { id: 'mv-1', updatedAt: '2026-01-05T00:00:00Z', name: 'local' };
    const remote = { id: 'mv-1', updatedAt: '2026-01-01T00:00:00Z', name: 'remote' };
    const r = mergeProjectRecord(local, remote);
    expect(r.remoteWins).toBe(false);
    expect(r.changed).toBe(false);
    expect(r.next.name).toBe('local');
  });

  it('a remote tombstone beats an older live local copy (no resurrection)', () => {
    const local = { id: 'mv-1', updatedAt: '2026-01-01T00:00:00Z', deleted: false, deletedAt: null };
    const remote = { id: 'mv-1', updatedAt: '2026-01-05T00:00:00Z', deleted: true, deletedAt: '2026-01-05T00:00:00Z' };
    const r = mergeProjectRecord(local, remote);
    expect(r.remoteWins).toBe(true);
    expect(r.next.deleted).toBe(true);
  });

  it('a same-updatedAt re-push is a no-op (changed=false, no churn)', () => {
    const local = { id: 'mv-1', updatedAt: '2026-01-05T00:00:00Z', name: 'same', deleted: false, deletedAt: null };
    const remote = { id: 'mv-1', updatedAt: '2026-01-05T00:00:00Z', name: 'same' };
    const r = mergeProjectRecord(local, remote);
    expect(r.changed).toBe(false);
  });
});

describe('composition document (render style `document`)', () => {
  const pointer = { directory: 'music-video/mv-1/composition/doc-a1', entry: 'index.html', updatedAt: '2026-01-02T00:00:00.000Z', source: { kind: 'template', name: 'layered' }, files: 3, bytes: 42 };
  const overlay = { enabled: true, titleLines: ['EXAMPLE'], meter: { label: 'LEVEL', keyframes: [[10, 40], [0, 100]] }, ticker: ['alpha'], timecode: false, timecodeStartSec: 0 };
  const withDocument = () => ({ ...baseProject(), composition: { version: 1, mode: 'document', textCues: [], style: { color: '#ffffff', font: 'sans' }, posterSec: null, document: pointer, overlay } });

  it('never takes the pointer from a create body, and keeps the HUD settings normalized', () => {
    const created = buildProjectRecord({ name: 'Doc', composition: { mode: 'document', document: pointer, overlay } }, { id: 'mv-9', now: '2026-01-01T00:00:00.000Z' });
    expect(created.composition.mode).toBe('document');
    expect(created.composition).not.toHaveProperty('document');
    expect(created.composition.overlay.meter.keyframes).toEqual([[0, 100], [10, 40]]);
  });

  it('keeps the stored pointer across a PATCH that echoes, forges or omits it', () => {
    const project = withDocument();
    const forged = { ...project.composition, document: { ...pointer, directory: 'music-video/mv-other/composition/doc-z9' } };
    expect(applyProjectPatch(project, { composition: forged }).composition.document).toEqual(pointer);
    const { document: _omit, ...omitted } = project.composition;
    const next = applyProjectPatch(project, { composition: { ...omitted, overlay: { ...overlay, timecode: true } } });
    expect(next.composition.document).toEqual(pointer);
    expect(next.composition.overlay.timecode).toBe(true);
    expect(applyProjectPatch(project, { composition: null }).composition).toBeNull();
  });

  it('carries the pointer to a clone (versions are immutable folders)', () => {
    const clone = cloneProjectRecord(withDocument(), { id: 'mv-2', now: '2026-01-03T00:00:00.000Z' });
    expect(clone.composition.document).toEqual(pointer);
  });

  it('keeps the pointer install-local: stripped from the wire, never taken from a peer, kept over a newer remote', async () => {
    const { sanitizeRecordForWire } = await import('../../lib/syncWire.js');
    const local = { ...withDocument(), updatedAt: '2026-01-01T00:00:00Z' };
    const wire = sanitizeRecordForWire('musicVideoProject', local);
    expect(wire.composition.mode).toBe('document');
    expect(wire.composition.overlay).toEqual(overlay);
    expect(wire.composition).not.toHaveProperty('document');

    const foreign = { ...pointer, directory: 'music-video/mv-1/composition/doc-peer' };
    const inserted = mergeProjectRecord(null, { ...local, id: 'mv-3', updatedAt: '2026-01-02T00:00:00Z', composition: { ...local.composition, document: foreign } }).next;
    expect(inserted.composition).not.toHaveProperty('document');
    const { next } = mergeProjectRecord(local, { ...local, updatedAt: '2026-01-05T00:00:00Z', name: 'remote edit', composition: { ...local.composition, mode: 'document', document: foreign } });
    expect(next.name).toBe('remote edit');
    expect(next.composition.document).toEqual(pointer);
  });

  it('keeps local document pointers when a newer peer has no composition', () => {
    const draft = { ...pointer, directory: 'music-video/mv-1/composition/doc-draft', source: { kind: 'generated', name: 'Mixed-media composition' } };
    const local = { ...withDocument(), composition: { ...withDocument().composition, documentDraft: draft } };
    const remote = { ...local, updatedAt: '2026-01-05T00:00:00Z', composition: null };
    const { next } = mergeProjectRecord(local, remote);
    expect(next.composition.document).toEqual(pointer);
    expect(next.composition.documentDraft).toEqual(draft);
    expect(next.composition.mode).toBeUndefined();
  });
});

it('preserves optional project moodboard uploads through create, patch and clone', () => {
  const styleReferences = [{ imageId: 'style.png', caption: 'silver grain' }];
  const project = buildProjectRecord({ name: 'Example', styleReferences }, { id: 'mv-example', now: '2026-01-01' });
  expect(project.styleReferences).toEqual(styleReferences);
  expect(applyProjectPatch(project, { name: 'Updated' }).styleReferences).toEqual(styleReferences);
  expect(cloneProjectRecord(project, { id: 'mv-clone', now: '2026-01-02' }).styleReferences).toEqual(styleReferences);
  expect(applyProjectPatch(project, { styleReferences: [] }).styleReferences).toEqual([]);
});
