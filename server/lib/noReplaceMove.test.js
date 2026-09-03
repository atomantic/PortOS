/**
 * `moveWithoutReplace` exists because `fs.rename` clobbers its destination, so the one
 * behavior worth pinning is the refusal — against a REAL temp directory, since the
 * guarantee comes from `link(2)`'s errno rather than from any logic here. The injected
 * seams cover only the two errnos a normal filesystem will not produce on demand.
 */

import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MOVE_CROSS_DEVICE,
  MOVE_DEST_EXISTS,
  MOVE_NO_REPLACE_UNSUPPORTED,
  moveWithoutReplace,
} from './noReplaceMove.js';

describe('moveWithoutReplace', () => {
  let dir;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'portos-no-replace-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('moves the bytes and drops the staged name', async () => {
    const from = join(dir, 'staged.glb');
    const to = join(dir, 'published.glb');
    await writeFile(from, 'rigged-bytes');

    expect(await moveWithoutReplace(from, to)).toBe(to);
    expect(await readFile(to, 'utf8')).toBe('rigged-bytes');
    await expect(stat(from)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a collision and leaves BOTH files byte-intact', async () => {
    const from = join(dir, 'staged.glb');
    const to = join(dir, 'published.glb');
    await writeFile(from, 'new');
    await writeFile(to, 'already-published');

    await expect(moveWithoutReplace(from, to)).rejects.toMatchObject({ code: MOVE_DEST_EXISTS });
    expect(await readFile(to, 'utf8')).toBe('already-published');
    expect(await readFile(from, 'utf8')).toBe('new');
  });

  it('fails cleanly rather than degrading when the filesystem cannot express a no-replace move', async () => {
    const unsupported = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    await expect(moveWithoutReplace('/a', '/b', { linkImpl: async () => { throw unsupported; } }))
      .rejects.toMatchObject({ code: MOVE_NO_REPLACE_UNSUPPORTED });

    const crossDevice = Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
    await expect(moveWithoutReplace('/a', '/b', { linkImpl: async () => { throw crossDevice; } }))
      .rejects.toMatchObject({ code: MOVE_CROSS_DEVICE });
  });

  it('keeps the publication when only the staged-name cleanup fails', async () => {
    const from = join(dir, 'staged.glb');
    const to = join(dir, 'published.glb');
    await writeFile(from, 'rigged-bytes');

    await expect(moveWithoutReplace(from, to, {
      unlinkImpl: async () => { throw new Error('unlink refused'); },
    })).resolves.toBe(to);
    expect(await readFile(to, 'utf8')).toBe('rigged-bytes');
  });
});
