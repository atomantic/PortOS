import { describe, it, expect } from 'vitest';
import { hasProcessCwdInside, probeProcessCwdInside } from './processCwdProbe.js';

const listing = (...cwds) => async () => ({ stdout: cwds.map((c, i) => `p${i + 1}\nn${c}\n`).join('') });

// Merged retirement substitutes a longer quiet period for an unknown answer (#16625),
// so unknown must stay distinct from both occupied and empty.
describe('probeProcessCwdInside', () => {
  const opts = (run, platform = 'linux') => ({ platform, run });
  it('answers true, false, or null when the probe cannot tell', async () => {
    expect(await probeProcessCwdInside('/work/wt', opts(listing('/', '/work/wt')))).toBe(true);
    expect(await probeProcessCwdInside('/work/wt', opts(listing('/')))).toBe(false);
    expect(await probeProcessCwdInside('/work/wt', opts(async () => { throw new Error('spawn lsof ENOENT'); }))).toBeNull();
    expect(await probeProcessCwdInside('/work/wt', opts(listing()))).toBeNull();
    expect(await probeProcessCwdInside('/work/wt', opts(listing('/'), 'win32'))).toBeNull();
    expect(await probeProcessCwdInside('', opts(listing('/')))).toBeNull();
  });
});

describe('hasProcessCwdInside', () => {
  const opts = (run, platform = 'linux') => ({ platform, run });

  it('finds a process in the directory or below it, not in a prefix-sharing sibling', async () => {
    expect(await hasProcessCwdInside('/work/wt', opts(listing('/', '/work/wt')))).toBe(true);
    expect(await hasProcessCwdInside('/work/wt', opts(listing('/', '/work/wt/sub/dir')))).toBe(true);
    expect(await hasProcessCwdInside('/work/wt', opts(listing('/', '/work/wt-other')))).toBe(false);
  });

  it('fails closed when the probe cannot answer', async () => {
    const rejects = async () => { throw new Error('spawn lsof ENOENT'); };
    expect(await hasProcessCwdInside('/work/wt', opts(rejects))).toBe(true);
    expect(await hasProcessCwdInside('/work/wt', opts(listing()))).toBe(true);
    expect(await hasProcessCwdInside('/work/wt', opts(listing('/'), 'win32'))).toBe(true);
    expect(await hasProcessCwdInside('', opts(listing('/')))).toBe(true);
  });

  it('reads only name fields and judges the listing lsof printed before a non-zero exit', async () => {
    const partial = async () => { throw Object.assign(new Error('exit 1'), { stdout: 'p1\nfcwd\nn/\np2\nfcwd\nn/work/wt\n' }); };
    expect(await hasProcessCwdInside('/work/wt', opts(partial))).toBe(true);
    expect(await hasProcessCwdInside('/work/other', opts(partial))).toBe(false);
  });
});
