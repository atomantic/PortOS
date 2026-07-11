import { describe, it, expect } from 'vitest';
import {
  buildProjectRecord,
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
      trackId: 'track-9', uploadedAudioFilename: null, concept: null,
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
});

describe('applyProjectPatch', () => {
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
        { sceneId: 's2', order: 1, startSec: 3, endSec: 4, beatAligned: false },
      ],
    };
    const next = applyProjectPatch(withScenes, { trackId: 't2' });
    expect(next.scenes[0]).toMatchObject({ beatAligned: false, startSec: 1, endSec: 2 });
    expect(next.scenes[1]).toMatchObject({ beatAligned: false, startSec: 3, endSec: 4 });
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
});

describe('setAudioAnalysis', () => {
  const analysis = { bpm: 120, beats: [0, 0.5], downbeats: [0], sections: [{ label: 'Section 1', startSec: 0, endSec: 1 }], durationSec: 1 };

  it('caches the analysis and flips a draft to analyzed', () => {
    const next = setAudioAnalysis(baseProject(), analysis);
    expect(next.audioAnalysis).toEqual(analysis);
    expect(next.status).toBe('analyzed');
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

  it('remote with a newer updatedAt wins', () => {
    const local = { id: 'mv-1', updatedAt: '2026-01-01T00:00:00Z', name: 'old' };
    const remote = { id: 'mv-1', updatedAt: '2026-01-05T00:00:00Z', name: 'new' };
    const r = mergeProjectRecord(local, remote);
    expect(r.remoteWins).toBe(true);
    expect(r.changed).toBe(true);
    expect(r.next.name).toBe('new');
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
