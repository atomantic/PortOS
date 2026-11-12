import { describe, expect, it } from 'vitest';
import { parseBlenderDriverLine } from './protocol.js';

const line = (event) => `PORTOS_BLENDER ${JSON.stringify(event)}`;

describe('parseBlenderDriverLine', () => {
  it('reads each driver event down to the fields the server acts on', () => {
    expect(parseBlenderDriverLine(line({ event: 'start', shot: 's010', frames: 108, blender: '5.2.3', engine: 'BLENDER_EEVEE', device: 'GPU' })))
      .toEqual({ event: 'start', shot: 's010', frames: 108, blender: '5.2.3', engine: 'BLENDER_EEVEE', device: 'GPU' });
    expect(parseBlenderDriverLine(line({ event: 'frame', shot: 's010', frame: 123, index: 4, total: 108, sec: 0.41, skipped: false, extra: 'ignored' })))
      .toEqual({ event: 'frame', shot: 's010', frame: 123, index: 4, total: 108, sec: 0.41, skipped: false });
    expect(parseBlenderDriverLine(line({ event: 'frame', shot: 's010', frame: 0, index: 1, total: 2, skipped: true }))).toMatchObject({ frame: 0, sec: 0, skipped: true });
    expect(parseBlenderDriverLine(line({ event: 'frame', shot: 's000', frame: -24, index: 1, total: 24, sec: 0.25, skipped: false })))
      .toEqual({ event: 'frame', shot: 's000', frame: -24, index: 1, total: 24, sec: 0.25, skipped: false });
    expect(parseBlenderDriverLine(line({ event: 'built', shot: 's010', sec: 1.2 }))).toEqual({ event: 'built', shot: 's010', sec: 1.2 });
    expect(parseBlenderDriverLine(line({ event: 'done', shot: 's010', sec: 44 }))).toEqual({ event: 'done', shot: 's010', sec: 44 });
    expect(parseBlenderDriverLine(line({ event: 'done', shot: 's010', sec: 44, imports: ['z.py', '../outside.py', '/outside.py', 'C:/outside.py', 'z.py', 'a.py', null, 'data.json'] })))
      .toEqual({ event: 'done', shot: 's010', sec: 44, imports: ['a.py', 'z.py'] });
    expect(parseBlenderDriverLine(line({ event: 'blend', shot: 's010', path: '/example/shot.blend' }))).toEqual({ event: 'blend', shot: 's010', path: '/example/shot.blend' });
    expect(parseBlenderDriverLine(line({ event: 'manifest', path: '/example/manifest.json' }))).toEqual({ event: 'manifest', shot: null, path: '/example/manifest.json' });
    expect(parseBlenderDriverLine(line({ event: 'error', message: 'NameError: example', traceback: 'Traceback…' })))
      .toEqual({ event: 'error', message: 'NameError: example', traceback: 'Traceback…' });
  });

  // A film prints whatever it likes; none of it may be taken for progress or crash the reader.
  it.each([
    ['ordinary Blender output', '00:01.365  render           | Saved: \'/example/frame_000072.jpg\''],
    ['a film printing JSON of its own', '{"event":"frame","frame":1,"index":1,"total":1}'],
    ['the prefix mid-line', `note: ${line({ event: 'done' })}`],
    ['a truncated event', 'PORTOS_BLENDER {"event":"frame","frame":12'],
    ['an event that is not an object', 'PORTOS_BLENDER ["frame"]'],
    ['an unknown event', line({ event: 'shutdown' })],
    ['a frame event without its counters', line({ event: 'frame', shot: 's010', frame: 12 })],
    ['a frame event with a fractional counter', line({ event: 'frame', frame: 1.5, index: 1, total: 4 })],
    ['a frame event with a negative counter', line({ event: 'frame', frame: -24, index: -1, total: 4 })],
    ['a value that is not a string', 42],
  ])('ignores %s', (_name, input) => {
    expect(parseBlenderDriverLine(input)).toBeNull();
  });

  it('bounds what an error event can carry and always reports an error as one', () => {
    const parsed = parseBlenderDriverLine(line({ event: 'error', message: 'x'.repeat(5000), traceback: 'y'.repeat(50000) }));
    expect(parsed.message).toHaveLength(2000);
    expect(parsed.traceback).toHaveLength(20000);
    expect(parseBlenderDriverLine(line({ event: 'error' }))).toEqual({ event: 'error', message: 'The film raised an error', traceback: null });
  });
});
