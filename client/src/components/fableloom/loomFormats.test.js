import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { LOOM_FORMATS, isTeleplayFormat, loomFormatHint, loomFormatLabel } from './loomFormats.js';

const SERVER_FORMATS = join('server', 'services', 'fableLoom', 'formats.js');

// Walk up from the working directory rather than assuming it — the client
// suite runs from `client/`, but a root-level runner would start elsewhere.
function findServerFormats() {
  let dir = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, SERVER_FORMATS);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// This module is a hand-mirror of server/services/fableLoom/formats.js. The
// server rejects an unknown format at the door, so a client-only id ships a
// select option that 400s on save with the whole suite still green — the
// mirror needs a guard, not just a comment saying to keep it in step.
describe('loomFormats', () => {
  it('offers exactly the ids the server accepts', () => {
    const path = findServerFormats();
    // A null path means the mirror source moved; failing here is the point —
    // silently skipping would retire the guard without anyone noticing.
    expect(path, `could not find ${SERVER_FORMATS} from ${resolve(process.cwd())}`).not.toBeNull();
    const source = readFileSync(path, 'utf8');
    const declared = source.match(/LOOM_FORMATS = Object\.freeze\(\[([\s\S]*?)\]\)/);
    expect(declared, 'server LOOM_FORMATS declaration not recognized').not.toBeNull();
    const serverIds = [...declared[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(serverIds.length).toBeGreaterThan(0);
    expect(LOOM_FORMATS.map((f) => f.id)).toEqual(serverIds);
  });

  it('labels and hints every id, and never falls through to a blank', () => {
    for (const { id } of LOOM_FORMATS) {
      expect(loomFormatLabel(id)).toBeTruthy();
      expect(loomFormatHint(id)).toBeTruthy();
    }
    // An unknown id degrades to the default rather than rendering empty chrome.
    expect(loomFormatLabel('haiku')).toBe(LOOM_FORMATS[0].label);
    expect(isTeleplayFormat('haiku')).toBe(false);
    expect(isTeleplayFormat('teleplay')).toBe(true);
  });
});
