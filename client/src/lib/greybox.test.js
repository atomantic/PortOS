import { describe, expect, it } from 'vitest';
import { greyboxSceneSchema } from '../../../server/lib/greyboxScene';
import { aspectRatio, blankGreybox, captureForShot, fovFromFocalLength, shotFromCamera, withShot, withoutShot, greyboxEditErrors, newGreyboxItem } from './greybox';

describe('greybox helpers', () => {
  it('maps lens to vertical fov and back, and aspect labels to ratios', () => {
    expect(fovFromFocalLength(35)).toBeCloseTo(37.85, 1);
    expect(aspectRatio('9:16')).toBeCloseTo(0.5625, 4);
    expect(aspectRatio('nonsense')).toBeCloseTo(16 / 9, 4);
  });

  it('mints server-valid unique shot ids from a name', () => {
    const scene = blankGreybox();
    const first = shotFromCamera(scene, { label: 'Wide', position: [0.123, 1, 2], target: [0, 0, 0], focalLengthMm: 35, aspect: '16:9' });
    expect(first.id).toBe('wide-2');
    const digitFirst = shotFromCamera(scene, { label: '3/4 view', position: [1, 1, 1], target: [0, 0, 0], focalLengthMm: 35, aspect: '1:1' });
    expect(digitFirst.id).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it('replaces a shot by id, appends a new one, and removes one', () => {
    const scene = blankGreybox();
    const moved = withShot(scene, { ...scene.shots[0], label: 'Moved' });
    expect(moved.shots).toHaveLength(1);
    expect(moved.shots[0].label).toBe('Moved');
    expect(withShot(scene, { ...scene.shots[0], id: 'other' }).shots).toHaveLength(2);
    expect(withoutShot(scene, 'wide').shots).toEqual([]);
  });

  it('finds the live capture row for a shot by its role tag', () => {
    const media = [
      { mediaKey: 'a.png', role: 'greybox-shot:wide', deleted: true },
      { mediaKey: 'b.png', role: 'greybox-shot:wide', deleted: false },
    ];
    expect(captureForShot(media, 'wide').mediaKey).toBe('b.png');
    expect(captureForShot(media, 'nope')).toBeNull();
  });
  it.each(['box', 'plane', 'cylinder', 'extrude'])('creates a server-valid %s with collision-free ids', (type) => {
    const scene = blankGreybox();
    const first = newGreyboxItem(scene, 'parts', type);
    scene.parts.push(first);
    const second = newGreyboxItem(scene, 'parts', type);
    scene.parts.push(second);
    expect(second.id).not.toBe(first.id);
    expect(greyboxEditErrors(scene)).toEqual([]);
    expect(greyboxSceneSchema.safeParse(scene).success).toBe(true);
  });

  it.each([
    ['duplicate ids', (scene) => { scene.parts.push({ ...scene.parts[0] }); }],
    ['unknown zone', (scene) => { scene.parts[0].zone = 'missing'; }],
    ['unknown anchor', (scene) => { scene.shots[0].figures = [{ anchorId: 'missing' }]; }],
    ['invalid extent', (scene) => { scene.parts[0].size[0] = 0; }],
  ])('mirrors the server rejection for %s before sending', (_name, invalidate) => {
    const scene = blankGreybox();
    invalidate(scene);
    expect(greyboxEditErrors(scene).length).toBeGreaterThan(0);
    expect(greyboxSceneSchema.safeParse(scene).success).toBe(false);
  });

});
