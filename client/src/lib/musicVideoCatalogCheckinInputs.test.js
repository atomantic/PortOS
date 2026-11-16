// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { musicVideoCatalogCheckinInputs } from './musicVideoCatalogCheckinInputs.js';
import { selectTakePatch, reviewTakePatch } from './musicVideoTakes.js';

const takeA = { takeId: 't-a', kind: 'image', assetId: 'a.png', status: 'candidate' };
const takeB = { takeId: 't-b', kind: 'image', assetId: 'b.png', status: 'candidate' };
const shot = (n, extra = {}) => ({
  sceneId: `s${n}`, order: n - 1, label: `Shot ${n}`, startSec: (n - 1) * 4, endSec: n * 4, prompt: 'walks in', framePrompt: 'a doorway',
  referenceImageId: 'a.png', takes: [takeA, takeB], shotSheet: { location: 'Station', characters: ['Lead'], checked: false }, ...extra,
});
const project = (scenes = [shot(1), shot(2)], extra = {}) => ({
  id: 'mv-1', updatedAt: '2026-01-01T00:00:00Z', castAndSets: { source: 'catalog', status: 'approved', catalogCheckin: { items: [], problems: [] } },
  concept: { subjects: [{ id: 'c1', kind: 'character', name: 'Lead', ingredientId: 'ing-1' }, { id: 'o1', kind: 'object', name: 'Lamp', ingredientId: 'ing-2' }] },
  scenes, ...extra,
});
const withShot = (base, sceneId, change) => ({ ...base, updatedAt: '2026-01-02T00:00:00Z', scenes: base.scenes.map((scene) => (scene.sceneId === sceneId ? change(scene) : scene)) });
const inputs = musicVideoCatalogCheckinInputs;

// Uniquely catches the check re-reading after an edit that cannot change it (#16306), or staying stale after one that can.
describe('musicVideoCatalogCheckinInputs', () => {
  const base = project();

  it.each([
    ['a newer updatedAt alone', (p) => ({ ...p, updatedAt: '2026-02-01T00:00:00Z' })],
    ['marking a shot done', (p) => withShot(p, 's1', (s) => ({ ...s, shotSheet: { ...s.shotSheet, checked: true } }))],
    ['using another take', (p) => withShot(p, 's1', (s) => ({ ...s, ...selectTakePatch(s, takeB) }))],
    ['rejecting a take', (p) => withShot(p, 's1', (s) => ({ ...s, ...reviewTakePatch(s, takeB, { status: 'rejected' }) }))],
    ['rejecting the take in use', (p) => withShot(p, 's1', (s) => ({ ...s, ...reviewTakePatch(s, takeA, { status: 'rejected' }) }))],
    ['a take note', (p) => withShot(p, 's1', (s) => ({ ...s, takes: s.takes.map((t) => ({ ...t, note: 'softer light' })) }))],
    ['a camera move', (p) => withShot(p, 's1', (s) => ({ ...s, camera: { move: 'dolly-in' } }))],
    ['a film look', (p) => withShot(p, 's1', (s) => ({ ...s, look: { grain: 0.4 } }))],
    ['a timing move that keeps the shot order', (p) => withShot(p, 's1', (s) => ({ ...s, endSec: 4.5 }))],
    ['the resolved check-in arriving', (p) => ({ ...p, castAndSets: { ...p.castAndSets, catalogCheckin: { items: [{ subjectId: 'c1' }], problems: [] } } })],
  ])('is unchanged by %s', (_name, change) => {
    expect(inputs(change(base))).toBe(inputs(base));
  });

  it.each([
    ['a frame reference pick', (p) => withShot(p, 's1', (s) => ({ ...s, frameReferenceIds: ['mvr-1'] }))],
    ['a clip reference pick', (p) => withShot(p, 's1', (s) => ({ ...s, clipReferenceIds: [] }))],
    ['a set reference', (p) => withShot(p, 's1', (s) => ({ ...s, setReference: { subjectId: 'p1' } }))],
    ['a cast look', (p) => withShot(p, 's1', (s) => ({ ...s, characterVariant: { ingredientId: 'ing-1', formId: 'f1' } }))],
    ['the shot sheet cast', (p) => withShot(p, 's1', (s) => ({ ...s, shotSheet: { ...s.shotSheet, characters: [] } }))],
    ['the shot sheet location', (p) => withShot(p, 's1', (s) => ({ ...s, shotSheet: { ...s.shotSheet, location: 'Roof' } }))],
    ['the shot sheet camera', (p) => withShot(p, 's1', (s) => ({ ...s, shotSheet: { ...s.shotSheet, cameraId: 'cam-2' } }))],
    ['the clip prompt', (p) => withShot(p, 's1', (s) => ({ ...s, prompt: 'Lead lights the lamp' }))],
    ['the end frame prompt', (p) => withShot(p, 's1', (s) => ({ ...s, endFramePrompt: 'Lead looks back' }))],
    ['a shot added', (p) => ({ ...p, scenes: [...p.scenes, shot(3)] })],
    ['a shot removed', (p) => ({ ...p, scenes: p.scenes.slice(1) })],
    ['a timing move that reorders the shots', (p) => withShot(p, 's1', (s) => ({ ...s, startSec: 9, endSec: 12 }))],
    ['a newly rendered frame take', (p) => withShot(p, 's1', (s) => ({ ...s, takes: [...s.takes, { takeId: 't-c', kind: 'image', assetId: 'c.png' }] }))],
    ['the concept subjects', (p) => ({ ...p, concept: { subjects: p.concept.subjects.slice(1) } })],
    ['the check-in status', (p) => ({ ...p, castAndSets: { ...p.castAndSets, status: 'review' } })],
  ])('changes with %s', (_name, change) => {
    expect(inputs(change(base))).not.toBe(inputs(base));
  });

  it('reads the start frame when automatic clip picks can drop it and a prop is checked', () => {
    const explicitFrame = withShot(base, 's1', (s) => ({ ...s, frameReferenceIds: ['mvr-1'] }));
    const selected = withShot(explicitFrame, 's1', (s) => ({ ...s, ...selectTakePatch(s, takeB) }));
    expect(inputs(selected)).not.toBe(inputs(explicitFrame));
    const noProps = (p) => ({ ...p, concept: { subjects: p.concept.subjects.filter((subject) => subject.kind !== 'object') } });
    expect(inputs(noProps(selected))).toBe(inputs(noProps(explicitFrame)));
  });
});
