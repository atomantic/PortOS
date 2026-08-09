/**
 * `upsertNote` — the "write a note whether or not it already exists" adapter
 * primitive both vault mirrors (Daily Log, YouTube ingest) go through.
 *
 * Exercised against a REAL temp vault rather than mocked `createNote`/
 * `updateNote`: the whole point of the helper is the ordering rule between
 * those two (createNote refuses an existing file, updateNote refuses a missing
 * one), and a test that stubs both would only re-assert the order it was handed.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

// obsidian.js captures PATHS.brain at module load for its vaults file, so the
// root is fixed for the whole file and per-test isolation comes from wiping the
// dir in beforeEach.
const tempRoot = createTempDataRoot('portos-obsidian-');

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makePathsProxy(actual, { dataRoot: tempRoot });
});

const { addVault, upsertNote, getNote } = await import('./obsidian.js');

const VAULT_DIR = join(tempRoot, 'vault');
let vaultId;

beforeEach(async () => {
  rmSync(tempRoot, { recursive: true, force: true });
  mkdirSync(join(VAULT_DIR, '.obsidian'), { recursive: true });
  const vault = await addVault({ name: 'Test Vault', path: VAULT_DIR });
  vaultId = vault.id;
});

afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

describe('obsidian.upsertNote', () => {
  it('creates the note when it does not exist yet, including missing folders', async () => {
    const path = 'Consumed/YouTube/note.md';
    expect(await upsertNote(vaultId, path, '# hello')).toBe(path);
    expect(readFileSync(join(VAULT_DIR, path), 'utf-8')).toBe('# hello');
  });

  it('overwrites the note when it already exists', async () => {
    const path = 'Daily Log/2026-04-17.md';
    await upsertNote(vaultId, path, 'first');
    expect(await upsertNote(vaultId, path, 'second')).toBe(path);
    expect(readFileSync(join(VAULT_DIR, path), 'utf-8')).toBe('second');
    // One note, not two — the create fallback must not have forked a duplicate.
    expect(await getNote(vaultId, path)).toMatchObject({ content: 'second' });
  });

  it('no-ops (rather than erroring) when the vault folder is gone', async () => {
    rmSync(VAULT_DIR, { recursive: true, force: true });
    expect(await upsertNote(vaultId, 'note.md', 'x')).toBeNull();
  });

  it('no-ops for an unknown vault id', async () => {
    expect(await upsertNote('does-not-exist', 'note.md', 'x')).toBeNull();
  });

  it('refuses a path that escapes the vault', async () => {
    expect(await upsertNote(vaultId, '../escaped.md', 'x')).toBeNull();
    expect(existsSync(join(tempRoot, 'escaped.md'))).toBe(false);
  });

  it('leaves an existing note untouched when the write is refused', async () => {
    // A path that resolves inside the vault stays writable; the guard above must
    // not be so broad that ordinary nested paths start failing.
    writeFileSync(join(VAULT_DIR, 'keep.md'), 'original');
    await upsertNote(vaultId, '../escaped.md', 'x');
    expect(readFileSync(join(VAULT_DIR, 'keep.md'), 'utf-8')).toBe('original');
  });
});
