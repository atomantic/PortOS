/**
 * No-DB unit test for readVideoHistoryStrict — the failure-vs-empty distinction
 * that keeps reconcile's prune from wiping live video rows on a transient read.
 *
 * The whole point of this reader (vs the live store's loadHistory, which uses
 * readJSONFile and collapses missing + unreadable + corrupt all to []) is that
 * ONLY a genuinely-absent file (ENOENT) is trusted-empty; an unreadable or
 * corrupt file must report ok:false so the caller skips pruning. We exercise all
 * branches against real temp files (no Postgres needed — the pool is never hit).
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm, chmod } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { readVideoHistoryStrict } from './db.js';

const dirs = [];
async function tmpDir() {
  const d = await mkdtemp(join(tmpdir(), 'mai-reconcile-'));
  dirs.push(d);
  return d;
}

afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => {});
});

describe('readVideoHistoryStrict', () => {
  it('missing file (ENOENT) → ok, empty (trusted-empty, safe to prune)', async () => {
    const d = await tmpDir();
    const res = await readVideoHistoryStrict(join(d, 'does-not-exist.json'));
    expect(res).toEqual({ ok: true, list: [] });
  });

  it('valid array → ok, parsed list', async () => {
    const d = await tmpDir();
    const p = join(d, 'video-history.json');
    await writeFile(p, JSON.stringify([{ id: 'a' }, { id: 'b' }]));
    const res = await readVideoHistoryStrict(p);
    expect(res.ok).toBe(true);
    expect(res.list).toHaveLength(2);
  });

  it('corrupt JSON → NOT ok (must not look empty → skip prune)', async () => {
    const d = await tmpDir();
    const p = join(d, 'video-history.json');
    await writeFile(p, '{ this is not json');
    const res = await readVideoHistoryStrict(p);
    expect(res.ok).toBe(false);
  });

  it('valid JSON but not an array → NOT ok', async () => {
    const d = await tmpDir();
    const p = join(d, 'video-history.json');
    await writeFile(p, JSON.stringify({ not: 'an array' }));
    const res = await readVideoHistoryStrict(p);
    expect(res.ok).toBe(false);
  });

  it('unreadable file (EACCES, not ENOENT) → NOT ok (the bug codex caught)', async () => {
    // chmod 000 makes the open fail with EACCES, which is NOT ENOENT — the old
    // tryReadFile path collapsed this to null/empty and would have pruned every
    // video row. Skip where chmod is ineffective (root, or some CI filesystems).
    const d = await tmpDir();
    const p = join(d, 'video-history.json');
    await writeFile(p, JSON.stringify([{ id: 'a' }]));
    await chmod(p, 0o000);
    const stillReadable = await readVideoHistoryStrict(p).then((r) => r.ok && r.list.length > 0).catch(() => false);
    if (stillReadable) {
      console.log('⏭️  EACCES case skipped: chmod 000 ineffective on this filesystem/user');
      return;
    }
    const res = await readVideoHistoryStrict(p);
    expect(res.ok).toBe(false);
    await chmod(p, 0o644).catch(() => {}); // restore so cleanup can remove it
  });
});
