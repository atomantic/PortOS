/**
 * `upsertNote` — the "write a note whether or not it already exists" adapter
 * primitive both vault mirrors (Daily Log, YouTube ingest) go through.
 *
 * Exercised against a REAL temp vault rather than mocked `createNote`/
 * `updateNote`: the whole point of the helper is the ordering rule between
 * those two (createNote refuses an existing file, updateNote refuses a missing
 * one), and a test that stubs both would only re-assert the order it was handed.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'fs';
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

const { addVault, upsertNote, getNote, createNote, updateNote, deleteNote } = await import('./obsidian.js');

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

// #9007: a remote caller that had already registered an existing host
// directory as a vault (e.g. the home directory) must not be able to use note
// CRUD to read/overwrite/delete anything outside the `.md` notes the scanner
// itself recognizes.
describe('obsidian note CRUD extension enforcement (#9007)', () => {
  it('createNote rejects a fully out-of-vault path and creates no directories', async () => {
    const result = await createNote(vaultId, '../newdir/escaped.md', 'x');
    expect(result).toMatchObject({ error: 'INVALID_PATH' });
    expect(existsSync(join(tempRoot, 'newdir'))).toBe(false);
  });

  it('getNote/updateNote/deleteNote refuse a non-.md path even when the file exists', async () => {
    writeFileSync(join(VAULT_DIR, 'secret.env'), 'API_KEY=x');

    expect(await getNote(vaultId, 'secret.env')).toMatchObject({ error: 'INVALID_PATH' });
    expect(await updateNote(vaultId, 'secret.env', 'y')).toMatchObject({ error: 'INVALID_PATH' });
    expect(await deleteNote(vaultId, 'secret.env')).toMatchObject({ error: 'INVALID_PATH' });

    // Untouched: neither the read nor the write/delete attempt changed it.
    expect(readFileSync(join(VAULT_DIR, 'secret.env'), 'utf-8')).toBe('API_KEY=x');
  });

  it('still serves ordinary .md notes after the extension check is added', async () => {
    writeFileSync(join(VAULT_DIR, 'ok.md'), 'hello');
    expect(await getNote(vaultId, 'ok.md')).toMatchObject({ content: 'hello' });
  });

  it('createNote refuses to create directories through an existing in-vault symlink that escapes it', async () => {
    const outsideDir = join(tempRoot, 'outside');
    mkdirSync(outsideDir, { recursive: true });
    symlinkSync(outsideDir, join(VAULT_DIR, 'linked'));

    const result = await createNote(vaultId, 'linked/newdir/escaped.md', 'x');
    expect(result).toMatchObject({ error: 'INVALID_PATH' });
    // The escaping segment must never have been created on the far side of
    // the symlink — this is the directory-creation-through-a-mid-path-symlink
    // case a single recursive `ensureDir(fullDirString)` cannot see (#9007).
    expect(existsSync(join(outsideDir, 'newdir'))).toBe(false);
  });
});
