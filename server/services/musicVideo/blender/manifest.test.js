import { describe, expect, it } from 'vitest';
import { blenderFilmProblems, blenderLeadSec, blenderSongEndSec, validateBlenderManifest } from './manifest.js';
import { blenderFrameName } from '../../film/renderIndex.js';
import { blenderStillName } from '../../film/renderJob.js';

const song = { durationSec: 10, fps: 24 };
const shot = (id, start, end, extra = {}) => ({ id, start, end, ...extra });
const check = (shots, extra = {}) => validateBlenderManifest({ title: 'Example Film', shots, ...extra }, song);

describe('validateBlenderManifest', () => {
  it('accepts a film contract shot list, snapping near-grid boundaries and keeping only the text that was set', () => {
    const { manifest, errors } = check([
      shot('s010', 0, 4.5004, { label: ' Cold open ', summary: 'One line', deps: ['shots/s010.py', 'kit', 'kit'], camera: '   ' }),
      shot('S-020_b', 4.5, 10.0005),
    ]);
    expect(errors).toEqual([]);
    expect(manifest).toEqual({ title: 'Example Film', options: [], shots: [
      { id: 's010', label: 'Cold open', start: 0, end: 4.5, summary: 'One line', deps: ['shots/s010.py', 'kit'] },
      { id: 'S-020_b', label: 'S-020_b', start: 4.5, end: 10 },
    ] });
  });

  it('lets the last shot run to the frame boundary just after a song that ends between frames, and no further', () => {
    // 161.534 s at 24 fps ends inside frame 3876: the picture may cover it (3877 frames) but not add another.
    const between = { durationSec: 161.534, fps: 24 };
    const ending = (frames) => validateBlenderManifest({ shots: [shot('s010', 0, frames / 24)] }, between);
    expect(ending(3876).errors).toEqual([]);
    expect(ending(3877)).toMatchObject({ errors: [], manifest: { shots: [{ end: 161.541667 }] } });
    expect(ending(3878).errors.join(' ')).toContain('after the song ends (161.534 s)');
    // A song that ends on a boundary gets no extra frame.
    expect(check([shot('s010', 0, 10 + 1 / 24)]).errors.join(' ')).toContain('after the song ends');
    // The film still tiles such a song: the fraction of a frame past its end is not a gap.
    expect(blenderFilmProblems({ fps: 24, shots: ending(3877).manifest.shots }, between)).toEqual([]);
    expect(blenderFilmProblems({ fps: 24, shots: ending(3876).manifest.shots }, between).join(' ')).toContain('No shot covers the song after');
  });

  it('stores the options a film declares in their declared order, keeping only the fields each type has', () => {
    const { manifest, errors } = check([shot('s010', 0, 1)], { options: [
      { key: 'look', label: ' Look ', type: 'choice', choices: [{ value: 'clay', label: 'Clay' }, { value: 'cartoon' }], default: 'cartoon', help: 'How the cast is drawn.', min: 3 },
      { key: 'overlay', type: 'boolean', default: true, choices: [{ value: 'ignored' }] },
      { key: 'grain', type: 'number', default: 0, min: 0, max: 1, step: 0.05 },
      { key: 'slate', type: 'text', default: 'Example slate' },
    ] });
    expect(errors).toEqual([]);
    expect(manifest.options).toEqual([
      { key: 'look', label: 'Look', type: 'choice', help: 'How the cast is drawn.', choices: [{ value: 'clay', label: 'Clay' }, { value: 'cartoon', label: 'cartoon' }], default: 'cartoon' },
      { key: 'overlay', label: 'overlay', type: 'boolean', default: true },
      { key: 'grain', label: 'grain', type: 'number', min: 0, max: 1, step: 0.05, default: 0 },
      { key: 'slate', label: 'slate', type: 'text', default: 'Example slate' },
    ]);
  });

  // Each row is one way a film can declare an option PortOS could not show or hand back safely.
  const option = (extra) => ({ key: 'look', type: 'boolean', default: false, ...extra });
  it.each([
    ['options that are not a list', { look: true }, '"options" must be a list'],
    ['more than 24 options', Array.from({ length: 25 }, (_, i) => option({ key: `o${i}` })), 'at most 24 options'],
    ['a key that could not name a field', [option({ key: '__proto__' })], '"key" must be'],
    ['the same key twice, ignoring case', [option(), option({ key: 'LOOK' })], 'the key is used twice'],
    ['an unknown type', [option({ type: 'color' })], '"type" must be one of choice, boolean, number, text'],
    ['no default', [{ key: 'look', type: 'boolean' }], '"default" is required'],
    ['a boolean default that is not a boolean', [option({ default: 'yes' })], '"default" must be true or false'],
    ['a choice with no choices', [option({ type: 'choice', default: 'a' })], '"choices" must list'],
    ['a choice value used twice', [option({ type: 'choice', choices: [{ value: 'a' }, { value: 'a' }], default: 'a' })], '"choices" must list'],
    ['a default that is not one of the choices', [option({ type: 'choice', choices: [{ value: 'a' }], default: 'b' })], '"default" must be one of a'],
    ['a number default outside its range', [option({ type: 'number', min: 0, max: 1, default: 2 })], '"default" must be at most 1'],
    ['a range that is upside down', [option({ type: 'number', min: 2, max: 1, default: 1 })], '"min" must not be above "max"'],
    ['a step of zero', [option({ type: 'number', step: 0, default: 1 })], '"step" must be above 0'],
    ['a text default that is too long', [option({ type: 'text', default: 'x'.repeat(2001) })], '"default" must be at most 2000 characters'],
    ['help that is not text', [option({ help: 5 })], '"help" must be text'],
  ])('refuses %s', (_name, options, reason) => {
    const { manifest, errors } = check([shot('s010', 0, 1)], { options });
    expect(manifest).toBeNull();
    expect(errors.join(' ')).toContain(reason);
  });

  // Each row is one way an authored script can hand PortOS a shot list it must not act on.
  it.each([
    ['a describe() result that is not a shot list', () => validateBlenderManifest({ title: 'x' }, song), '"shots" list'],
    ['no shots', () => check([]), 'no shots'],
    ['more than 400 shots', () => check(Array.from({ length: 401 }, (_, i) => shot(`s${i}`, 0, 1))), 'at most 400'],
    ['an id that could name a path', () => check([shot('../etc', 0, 1)]), '"id" must be'],
    ['an id longer than 40 characters', () => check([shot('s'.repeat(41), 0, 1)]), '"id" must be'],
    ['two shots whose ids differ only by case', () => check([shot('s010', 0, 1), shot('S010', 1, 2)]), 'used twice'],
    ['times that are not numbers', () => check([shot('s010', '0', 1)]), 'must be numbers'],
    ['a boundary off the frame grid', () => check([shot('s010', 0, 1.02)]), 'frame boundary'],
    ['a shot that ends before it starts', () => check([shot('s010', 2, 1)]), '0 <= start < end'],
    ['a zero-length shot', () => check([shot('s010', 1, 1)]), '0 <= start < end'],
    ['a shot that overlaps frame 0', () => check([shot('s010', -1, 1)]), 'Shot s010: overlaps frame 0'],
    ['a shot past the end of the song', () => check([shot('s010', 0, 10.5)]), 'after the song ends'],
    ['overlapping shots', () => check([shot('s010', 0, 5), shot('s020', 4, 8)]), 'before shot s010 ends'],
    ['shots out of time order', () => check([shot('s020', 5, 8), shot('s010', 0, 5)]), 'before shot s020 ends'],
    ['text longer than the film contract allows', () => check([shot('s010', 0, 1, { action: 'x'.repeat(4001) })]), '"action" must be text'],
    ['a dependency outside src/', () => check([shot('s010', 0, 1, { deps: ['../secrets'] })]), '"deps" must list'],
    ['an absolute dependency', () => check([shot('s010', 0, 1, { deps: ['/etc/passwd'] })]), '"deps" must list'],
    ['negative handle seconds', () => check([shot('s010', 1, 2, { handles: { in: -0.25 } })]), '"handles.in" must be between 0 and 4'],
    ['handles longer than 4 seconds', () => check([shot('s010', 1, 2, { handles: { out: 4.5 } })]), '"handles.out" must be between 0 and 4'],
    ['handles off the frame grid', () => check([shot('s010', 1, 2, { handles: { out: 0.27 } })]), 'handles.out must fall on a frame boundary'],
    ['an in handle that starts before 0 s', () => check([shot('s010', 0.25, 2, { handles: { in: 0.5 } })]), 'starts before 0 s'],
    ['unknown handle keys', () => check([shot('s010', 1, 2, { handles: { left: 0.25 } })]), 'may only declare "in" and "out"'],
  ])('refuses %s', (_name, run, reason) => {
    const { manifest, errors } = run();
    expect(manifest).toBeNull();
    expect(errors.join(' ')).toContain(reason);
  });

  it('accepts a lead-in that ends at 0 and stays inside 120 s, and names a broken one', () => {
    const songAfter = [shot('s010', 0, 10)];
    const accepted = check([shot('s000', -6, 0), ...songAfter]);
    expect(accepted.errors).toEqual([]);
    expect(accepted.manifest.shots.map(({ id, start, end }) => ({ id, start, end }))).toEqual([
      { id: 's000', start: -6, end: 0 }, { id: 's010', start: 0, end: 10 },
    ]);
    expect(accepted.manifest).not.toHaveProperty('leadSec');
    expect(blenderLeadSec(accepted.manifest.shots)).toBe(6);
    expect(blenderSongEndSec(accepted.manifest.shots)).toBe(10);
    expect(check([shot('s000', -120, 0), ...songAfter]).errors).toEqual([]);
    expect(check([shot('s000', -0.5, 0), ...songAfter]).errors).toEqual([]);
    expect(check([shot('s000', -2, 0, { handles: { in: 1 } }), ...songAfter]).manifest.shots[0].handles).toEqual({ in: 1, out: 0 });
    expect(check([shot('s000', -6, -1), ...songAfter]).errors.join(' ')).toContain('Shot s000: ends at -1 s; a lead-in must end exactly at 0 s');
    expect(check([shot('s000', -6, -2), shot('s001', -1, 0), ...songAfter]).errors.join(' ')).toContain('Shot s001: leaves a gap after shot s000');
    expect(check([shot('s000', -0.25, 0), ...songAfter]).errors.join(' ')).toContain('Shot s000: a lead-in shot is 0.25 s');
    expect(check([shot('s000', -121, 0), ...songAfter]).errors.join(' ')).toContain('Shot s000: a lead-in shot is 121 s');
    const over = check([shot('s000', -121, -71), shot('s001', -71, -21), shot('s002', -21, 0), ...songAfter]);
    expect(over.errors.join(' ')).toContain('Shot s002: the lead-in runs');
    expect(blenderFrameName(-144, 'final')).toBe('frame_m000144.png');
    expect(blenderFrameName(0, 'final')).toBe('frame_000000.png');
    expect(blenderFrameName(48, 'preview')).toBe('frame_000048.jpg');
    expect(blenderStillName(-144, 24)).toBe('tm000006000.png');
    expect(blenderStillName(72, 24)).toBe('t000003000.png');
  });

  it('normalizes valid frame-grid handles and omits empty ones', () => {
    const { manifest, errors } = check([
      shot('s010', 0, 1, { handles: { in: 0, out: 0 } }),
      shot('s020', 1, 2, { handles: { in: 0.25, out: 0.5 } }),
    ]);
    expect(errors).toEqual([]);
    expect(manifest.shots[0].handles).toBeUndefined();
    expect(manifest.shots[1].handles).toEqual({ in: 0.25, out: 0.5 });
  });

  it('reports every broken shot, not just the first, so one sync shows the whole list of fixes', () => {
    const { errors } = check([shot('bad id', 0, 1), shot('s020', 1, 0.5), shot('s030', 2, 3)]);
    expect(errors).toHaveLength(2);
  });
});

describe('blenderFilmProblems', () => {
  const synced = (shots, fps = 24) => ({ fps, shots });

  it('requires every song frame, including a one-frame gap at either end', () => {
    expect(blenderFilmProblems(synced([shot('s010', 0, 5), shot('s020', 5, 10)]), song)).toEqual([]);
    expect(blenderFilmProblems(synced([shot('s010', 1 / 24, 10)]), song).join(' ')).toContain('first 0.042 s');
    expect(blenderFilmProblems(synced([shot('s010', 0, 10 - 1 / 24)]), song).join(' ')).toContain('after 9.958 s');
    expect(blenderFilmProblems(synced([shot('s010', 0, 9.96)], 25), { durationSec: 10, fps: 25 }).join(' ')).toContain('after 9.96 s');
  });


  it('names a late start, a gap between shots and an early end', () => {
    expect(blenderFilmProblems(synced([shot('s010', 1, 4), shot('s020', 5, 8)]), song)).toEqual([
      'No shot covers the first 1 s of the song (shot s010 starts there).',
      'No shot covers 4 s to 5 s (between s010 and s020).',
      'No shot covers the song after 8 s (it runs to 10 s).',
    ]);
    expect(blenderFilmProblems(synced([shot('s000', -6, 0), shot('s010', 0, 10)]), song)).toEqual([]);
    expect(blenderFilmProblems(synced([shot('s000', -6, 0), shot('s010', 1, 10)]), song).join(' ')).toContain('No shot covers 0 s to 1 s');
  });

  it('asks for a new sync after a frame-rate change, and for an analysis before the song can be checked', () => {
    const film = synced([shot('s010', 0, 10)]);
    expect(blenderFilmProblems(film, { ...song, fps: 30 })).toEqual(['The frame rate changed from 24 to 30 since the last sync. Sync shots from scripts again.']);
    expect(blenderFilmProblems(film, { fps: 24, durationSec: undefined })).toEqual(['Analyze the song: the film cannot be checked against it yet.']);
  });

  it('names missing in and out handles required by dissolves and accepts sufficient handles', () => {
    const shots = [shot('s010', 0, 2), shot('s020', 2, 5), shot('s030', 5, 10)];
    const cutEffects = [{ style: 'dissolve', index: 1, cutFrame: 120, needOutFrames: 6, needInFrames: 6 }];
    expect(blenderFilmProblems(synced(shots), { ...song, cutEffects })).toEqual([
      'Shot s020 needs 0.25 s of out handle for its dissolve',
      'Shot s030 needs 0.25 s of in handle for its dissolve',
    ]);
    const withHandles = [shot('s010', 0, 2), shot('s020', 2, 5, { handles: { out: 0.25 } }), shot('s030', 5, 10, { handles: { in: 0.25 } })];
    expect(blenderFilmProblems(synced(withHandles), { ...song, cutEffects })).toEqual([]);
  });
});
