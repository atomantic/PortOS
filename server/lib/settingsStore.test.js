import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createSettingsStore } from './settingsStore.js';

/**
 * `createSettingsStore` is the one owner of the `read → merge defaults → PATCH →
 * write back` shape five services used to hand-roll. The contract that matters
 * most is the strict half (#4115): a present-but-unreadable file must never be
 * read as the shipped defaults, because `update` writes whatever `get` returned
 * straight back over the file. Corrupt JSON is the portable way to produce
 * "present but unreadable" — it fails the parse identically on every platform
 * and needs no privileges.
 */
describe('createSettingsStore', () => {
  const DEFAULTS = { enabled: false, provider: null, historyCap: 200 };
  const CORRUPT = '{"enabled": true,';
  let dir;
  let file;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'settings-store-test-'));
    file = join(dir, 'nested', 'settings.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads an absent file as the shipped defaults without creating it', async () => {
    const store = createSettingsStore(file, DEFAULTS);
    expect(await store.get()).toEqual(DEFAULTS);
    expect(existsSync(file)).toBe(false);
  });

  it('merges the stored file over the defaults so new default keys appear', async () => {
    writeFileSync(join(dir, 'flat.json'), JSON.stringify({ provider: 'p1' }));
    const store = createSettingsStore(join(dir, 'flat.json'), DEFAULTS);
    expect(await store.get()).toEqual({ enabled: false, provider: 'p1', historyCap: 200 });
  });

  it('update persists the patch, returns the merged result, and creates missing directories', async () => {
    const store = createSettingsStore(file, DEFAULTS);
    const next = await store.update({ enabled: true });
    expect(next).toEqual({ ...DEFAULTS, enabled: true });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ ...DEFAULTS, enabled: true });
    expect(await store.get()).toEqual(next);
  });

  it('treats undefined patch values as absent and null as an explicit clear', async () => {
    const store = createSettingsStore(file, DEFAULTS);
    await store.update({ provider: 'p1', historyCap: 50 });
    const next = await store.update({ provider: null, historyCap: undefined, enabled: undefined });
    expect(next).toEqual({ enabled: false, provider: null, historyCap: 50 });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ enabled: false, provider: null, historyCap: 50 });
  });

  it('runs normalize on every read, after the defaults merge', async () => {
    writeFileSync(join(dir, 'flat.json'), JSON.stringify({ historyCap: 'abc' }));
    const store = createSettingsStore(join(dir, 'flat.json'), DEFAULTS, {
      normalize: (s) => (Number.isInteger(s.historyCap) ? s : { ...s, historyCap: DEFAULTS.historyCap }),
    });
    expect((await store.get()).historyCap).toBe(200);
    // update starts from the normalized read, so the repaired value is what lands on disk.
    await store.update({ enabled: true });
    expect(JSON.parse(readFileSync(join(dir, 'flat.json'), 'utf8'))).toEqual({ enabled: true, provider: null, historyCap: 200 });
  });

  it('resolves a function filePath lazily on every call', async () => {
    let current = join(dir, 'a.json');
    const store = createSettingsStore(() => current, DEFAULTS);
    await store.update({ provider: 'a' });
    current = join(dir, 'b.json');
    await store.update({ provider: 'b' });
    expect(JSON.parse(readFileSync(join(dir, 'a.json'), 'utf8')).provider).toBe('a');
    expect(JSON.parse(readFileSync(join(dir, 'b.json'), 'utf8')).provider).toBe('b');
    expect(store.path()).toBe(join(dir, 'b.json'));
  });

  describe('strict reads (#4115)', () => {
    it('get rejects on a corrupt file instead of fabricating the defaults', async () => {
      writeFileSync(join(dir, 'flat.json'), CORRUPT);
      const store = createSettingsStore(join(dir, 'flat.json'), DEFAULTS);
      await expect(store.get()).rejects.toThrow(/Unreadable JSON file/);
    });

    it('update leaves a corrupt file byte-for-byte intact', async () => {
      const target = join(dir, 'flat.json');
      writeFileSync(target, CORRUPT);
      const store = createSettingsStore(target, DEFAULTS);
      await expect(store.update({ enabled: true })).rejects.toThrow(/Unreadable JSON file/);
      expect(
        readFileSync(target, 'utf8'),
        'writing defaults over settings we failed to read is the data loss this prevents'
      ).toBe(CORRUPT);
    });

    it('refuses an array-shaped file rather than spreading its indexes into the settings', async () => {
      const target = join(dir, 'flat.json');
      writeFileSync(target, '["enabled"]');
      const store = createSettingsStore(target, DEFAULTS);
      await expect(store.get()).rejects.toThrow(/Unreadable JSON file/);
      await expect(store.update({ enabled: true })).rejects.toThrow(/Unreadable JSON file/);
      expect(readFileSync(target, 'utf8')).toBe('["enabled"]');
    });
  });

  it('serializes concurrent updates so no patch is lost', async () => {
    const store = createSettingsStore(file, { n: 0, a: null, b: null });
    const [first, second] = await Promise.all([
      store.update({ a: 'A' }),
      store.update({ b: 'B' }),
    ]);
    expect(first).toMatchObject({ a: 'A' });
    expect(second).toMatchObject({ a: 'A', b: 'B' });
    expect(await store.get()).toEqual({ n: 0, a: 'A', b: 'B' });
  });
});
