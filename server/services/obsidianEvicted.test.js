/**
 * Obsidian readers against an EVICTED (iCloud-offloaded) note — #3704.
 *
 * Kept separate from `obsidian.test.js` because that suite deliberately runs
 * against a real temp vault with no mocks; here `../lib/icloudFile.js` is mocked
 * so one specific note behaves as evicted while its neighbours read normally.
 *
 * What this pins: an evicted note must never be *silently* dropped. Before the
 * guard, reading one blocked the process forever; the guard makes the read fail
 * fast, and the risk that replaces the hang is a vault-wide reader reporting
 * "no results" for a query whose answer sits in an un-downloaded note. Each
 * reader therefore reports a `skippedUnavailable` count, and `getNote` reports
 * NOTE_EVICTED rather than NOTE_NOT_FOUND.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { createTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

const tempRoot = createTempDataRoot('portos-obsidian-evicted-');

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makePathsProxy(actual, { dataRoot: tempRoot });
});

// Only `evicted.md` is treated as offloaded; every other path reads for real, so
// the assertions below distinguish "skipped that one note" from "read nothing".
// `isSuspectedDataless` defaults to false so the reader tests below are unaffected
// by the write-path guard; the write tests drive it per-case.
vi.mock('../lib/icloudFile.js', () => ({
  ICLOUD_NOT_MATERIALIZED: 'ICLOUD_NOT_MATERIALIZED',
  readIfMaterialized: vi.fn(async (path) => {
    if (path.endsWith('evicted.md')) {
      throw Object.assign(new Error('evicted'), { code: 'ICLOUD_NOT_MATERIALIZED' });
    }
    return readFile(path, 'utf-8');
  }),
  isSuspectedDataless: vi.fn(async () => false),
  materializeAndWait: vi.fn(async () => true),
}));

const {
  addVault, scanVault, searchNotes, getVaultTags, getVaultGraph,
  getNote, updateNote, createNote, upsertNote, deleteNote
} = await import('./obsidian.js');

const VAULT_DIR = join(tempRoot, 'vault');
let vaultId;

beforeEach(async () => {
  rmSync(tempRoot, { recursive: true, force: true });
  mkdirSync(join(VAULT_DIR, '.obsidian'), { recursive: true });
  // `readable.md` and `evicted.md` both match the search term and share a tag, so
  // every reader below has exactly one skipped note and one real hit.
  writeFileSync(join(VAULT_DIR, 'readable.md'), '---\ntags: [biology]\n---\nmitochondria here\n[[evicted]]\n');
  writeFileSync(join(VAULT_DIR, 'evicted.md'), '---\ntags: [biology, offloaded]\n---\nmitochondria there too\n');
  const vault = await addVault({ name: 'Test Vault', path: VAULT_DIR });
  vaultId = vault.id;
});

afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

describe('obsidian readers with an evicted note', () => {
  it('scanVault skips the evicted note and reports the count', async () => {
    const result = await scanVault(vaultId);
    expect(result.notes.map(n => n.name)).toEqual(['readable']);
    expect(result.skippedUnavailable).toBe(1);
  });

  it('searchNotes reports skipped notes instead of implying no match exists', async () => {
    const result = await searchNotes(vaultId, 'mitochondria');
    // The term is in BOTH notes; only the readable one can be reported.
    expect(result.results).toHaveLength(1);
    expect(result.results[0].name).toBe('readable');
    // Without this the UI renders a bare "No/1 results" and the user concludes
    // the other note doesn't contain the term.
    expect(result.skippedUnavailable).toBe(1);
  });

  it('getVaultTags under-counts visibly, not silently', async () => {
    const result = await getVaultTags(vaultId);
    const biology = result.tags.find(t => t.tag === 'biology');
    expect(biology.count).toBe(1);            // 2 notes carry it; 1 is unreadable
    expect(result.tags.find(t => t.tag === 'offloaded')).toBeUndefined();
    expect(result.skippedUnavailable).toBe(1);
  });

  it('getVaultGraph drops the evicted node and says so', async () => {
    const result = await getVaultGraph(vaultId);
    expect(result.nodes.map(n => n.name)).toEqual(['readable']);
    // The [[evicted]] wikilink can't resolve to a node that was never collected,
    // so the edge silently vanishes too — hence the count.
    expect(result.edges).toHaveLength(0);
    expect(result.skippedUnavailable).toBe(1);
  });

  it('getNote reports NOTE_EVICTED, not NOTE_NOT_FOUND', async () => {
    const result = await getNote(vaultId, 'evicted.md');
    // NOTE_NOT_FOUND would tell the user a note they can see in Obsidian is gone.
    expect(result.error).toBe('NOTE_EVICTED');
    expect(result.message).toMatch(/iCloud/i);
  });

  it('getNote still reads a materialized note normally', async () => {
    const result = await getNote(vaultId, 'readable.md');
    expect(result.error).toBeUndefined();
    expect(result.content).toContain('mitochondria');
  });

  it('a non-eviction read error still propagates (not swallowed as a skip)', async () => {
    const { readIfMaterialized } = await import('../lib/icloudFile.js');
    readIfMaterialized.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'EIO' }));
    await expect(getNote(vaultId, 'readable.md')).rejects.toThrow('boom');
  });
});

/**
 * The WRITE side — #3706.
 *
 * Overwriting an evicted note blocks exactly like reading one: `writeFile`'s
 * O_TRUNC does NOT skip materialization (measured — 822ms dataless vs 1ms
 * materialized for the identical call). These pin that `updateNote` never issues
 * that write, which is the whole defence: a blocked write cannot be cancelled,
 * so the only safe move is not to make it.
 *
 * Assertions read the file back off disk rather than spying on `writeFile`, so
 * they pin the OBSERVABLE outcome ("the note's bytes are untouched") instead of
 * the current implementation's choice of fs call.
 */
describe('obsidian updateNote against an evicted note', () => {
  const NOTE = 'readable.md';
  const ORIGINAL = '---\ntags: [biology]\n---\nmitochondria here\n[[evicted]]\n';

  beforeEach(async () => {
    const icloud = await import('../lib/icloudFile.js');
    icloud.isSuspectedDataless.mockReset().mockResolvedValue(false);
    icloud.materializeAndWait.mockReset().mockResolvedValue(true);
  });

  it('refuses the write and leaves the note byte-for-byte intact', async () => {
    const icloud = await import('../lib/icloudFile.js');
    // Still dataless on the re-screen after materializing => refuse.
    icloud.isSuspectedDataless.mockResolvedValue(true);

    const result = await updateNote(vaultId, NOTE, 'REPLACEMENT');

    expect(result.error).toBe('NOTE_EVICTED');
    expect(result.message).toMatch(/iCloud/i);
    // The load-bearing assertion: the blocking write was never issued.
    expect(readFileSync(join(VAULT_DIR, NOTE), 'utf-8')).toBe(ORIGINAL);
  });

  it('materializes and WAITS rather than firing and forgetting', async () => {
    const icloud = await import('../lib/icloudFile.js');
    icloud.isSuspectedDataless.mockResolvedValue(true);

    await updateNote(vaultId, NOTE, 'REPLACEMENT');

    // A write must not silently skip, so unlike the read paths this one has to
    // await the download before deciding — hence materializeAndWait, never
    // requestMaterialization.
    expect(icloud.materializeAndWait).toHaveBeenCalledTimes(1);
    // realpath'd: resolveVaultPath resolves the vault root, and the temp dir is
    // reached through /var -> /private/var on macOS.
    expect(icloud.materializeAndWait).toHaveBeenCalledWith(
      join(realpathSync(VAULT_DIR), NOTE),
      expect.objectContaining({ label: 'Obsidian note' })
    );
  });

  it('writes normally once materialization actually lands', async () => {
    const icloud = await import('../lib/icloudFile.js');
    // Dataless on the first screen, materialized on the re-screen.
    icloud.isSuspectedDataless.mockResolvedValueOnce(true).mockResolvedValue(false);

    const result = await updateNote(vaultId, NOTE, 'REPLACEMENT');

    expect(result.error).toBeUndefined();
    expect(readFileSync(join(VAULT_DIR, NOTE), 'utf-8')).toBe('REPLACEMENT');
  });

  it('re-screens instead of trusting brctl exit-0', async () => {
    const icloud = await import('../lib/icloudFile.js');
    icloud.isSuspectedDataless.mockResolvedValue(true);
    // brctl exit-0 means the download was ACCEPTED, not that the bytes are local.
    icloud.materializeAndWait.mockResolvedValue(true);

    const result = await updateNote(vaultId, NOTE, 'REPLACEMENT');

    // Trusting that `true` would issue the very write this guard exists to prevent.
    expect(result.error).toBe('NOTE_EVICTED');
    expect(icloud.isSuspectedDataless).toHaveBeenCalledTimes(2);
  });

  it('costs nothing on the healthy path — no materialize for a normal note', async () => {
    const icloud = await import('../lib/icloudFile.js');

    const result = await updateNote(vaultId, NOTE, 'REPLACEMENT');

    expect(result.error).toBeUndefined();
    expect(icloud.materializeAndWait).not.toHaveBeenCalled();
    expect(readFileSync(join(VAULT_DIR, NOTE), 'utf-8')).toBe('REPLACEMENT');
  });

  it('createNote does not screen — a file that does not exist cannot be dataless', async () => {
    const icloud = await import('../lib/icloudFile.js');

    const result = await createNote(vaultId, 'brand-new.md', 'fresh');

    expect(result.error).toBeUndefined();
    // Pins the deliberate no-guard decision so a later "add it for symmetry"
    // change has to argue with a test rather than slip through.
    expect(icloud.isSuspectedDataless).not.toHaveBeenCalled();
  });

  it('upsertNote degrades to a skipped mirror, never a hang or a throw', async () => {
    const icloud = await import('../lib/icloudFile.js');
    icloud.isSuspectedDataless.mockResolvedValue(true);

    // upsertNote is how the BACKGROUND mirrors (Brain daily log, YouTube ingest)
    // reach updateNote — with no user in the loop, so it must fail quietly.
    await expect(upsertNote(vaultId, NOTE, 'REPLACEMENT')).resolves.toBeNull();
    expect(readFileSync(join(VAULT_DIR, NOTE), 'utf-8')).toBe(ORIGINAL);
  });
});

/**
 * The DELETE side — #3713.
 *
 * `deleteNote` was the third candidate for the #3706 treatment, on the theory
 * that `unlink` might materialize the way `link` does. Measured: it does not
 * (0.1 ms dataless across three runs — two at 512 KB, one at 5 MB — vs 884 ms to
 * read a separate 5 MB dataless fixture), so the correct outcome is *no guard*.
 * These pin that absence — a
 * "for symmetry with updateNote" change has to argue with a test, because the
 * guard it would add is actively harmful: `materializeAndWait` would download
 * the whole file just to unlink it.
 */
describe('obsidian deleteNote against an evicted note', () => {
  beforeEach(async () => {
    const icloud = await import('../lib/icloudFile.js');
    icloud.isSuspectedDataless.mockReset().mockResolvedValue(true);
    icloud.materializeAndWait.mockReset().mockResolvedValue(true);
  });

  it('deletes an evicted note outright — no screen, no download', async () => {
    const icloud = await import('../lib/icloudFile.js');

    // The screen is mocked to report EVERY path dataless; the delete must still
    // go through, because the unlink it issues cannot block.
    await expect(deleteNote(vaultId, 'evicted.md')).resolves.toBe(true);

    expect(existsSync(join(VAULT_DIR, 'evicted.md'))).toBe(false);
    expect(icloud.isSuspectedDataless).not.toHaveBeenCalled();
    expect(icloud.materializeAndWait).not.toHaveBeenCalled();
  });

  it('still reports NOTE_NOT_FOUND for a path with nothing at it', async () => {
    // The existsSync precondition is a stat, which never materializes, so it
    // keeps working unchanged on an evicted vault.
    const result = await deleteNote(vaultId, 'no-such-note.md');
    expect(result.error).toBe('NOTE_NOT_FOUND');
  });
});
