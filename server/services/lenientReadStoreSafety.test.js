/**
 * Write-back boundaries for stores that used to read with `tryReadFile` +
 * `safeJSONParse` (#12440): a truncated, empty, or unreadable file must never be
 * replaced by defaults on the next mutation. Real disk under a temp data root;
 * the EACCES case injects a read fault on the exact path.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';

const disk = vi.hoisted(() => {
  const { mkdtempSync } = require('fs');
  const { tmpdir } = require('os');
  const { join } = require('path');
  return { root: mkdtempSync(join(tmpdir(), 'lenient-read-store-safety-')), fault: null, once: false };
});
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readFile: (...args) => {
      if (args[0] === disk.fault) {
        // `once` models a transient fault: later reads of the same path succeed.
        if (disk.once) disk.fault = null;
        return Promise.reject(Object.assign(new Error('injected read fault'), { code: 'EACCES' }));
      }
      return actual.readFile(...args);
    }
  };
});
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: disk.root, extraOverrides: { root: disk.root } }));
vi.mock('./sharing/recordEvents.js', () => ({}));

const { PATHS } = await import('../lib/fileUtils.js');

afterEach(() => { disk.fault = null; disk.once = false; });
afterAll(() => rm(disk.root, { recursive: true, force: true }));

const unreadable = /Unreadable JSON file/;
const write = async (path, bytes) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
};

describe('lenient-read stores refuse to write over an untrusted file', () => {
  it('digital twin meta.json keeps its registry and tombstones, and still initializes when absent', async () => {
    const twin = await import('./digital-twin-meta.js');
    const path = twin.META_FILE;
    const seed = JSON.stringify({ version: '1.0.0', documents: [{ id: 'keep' }], deletedDocuments: [{ id: 'gone' }], settings: {} });
    for (const bytes of ['{truncated', '', '[]', seed]) {
      twin.cache.meta.data = null;
      await write(path, bytes);
      disk.fault = bytes === seed ? path : null;
      await expect(twin.updateSettings({ maxContextTokens: 1 })).rejects.toThrow(unreadable);
      await expect(twin.saveMeta({ ...twin.DEFAULT_META })).rejects.toThrow(unreadable);
      disk.fault = null;
      expect(await readFile(path, 'utf8')).toBe(bytes);
    }
    // Repaired input recovers without a restart and keeps its unrelated records.
    twin.cache.meta.data = null;
    await write(path, seed);
    await twin.updateSettings({ maxContextTokens: 1 });
    const saved = JSON.parse(await readFile(path, 'utf8'));
    expect(saved.deletedDocuments).toEqual([{ id: 'gone' }]);
    expect(saved.settings.maxContextTokens).toBe(1);
    // A transient fault on the load must not let defaults through when the
    // guard's own re-read of the healthy file succeeds.
    await write(path, seed);
    twin.cache.meta.data = null;
    disk.fault = path;
    disk.once = true;
    // Windows retries EACCES (swap-window handling), so the one-shot fault may be
    // absorbed and the update succeed; either way no defaults may overwrite the file.
    await twin.updateSettings({ maxContextTokens: 3 }).catch((err) => expect(err.message).toMatch(unreadable));
    expect(JSON.parse(await readFile(path, 'utf8')).deletedDocuments).toEqual([{ id: 'gone' }]);
    // The defaults served for an untrusted read are not the shared module object.
    await write(path, '{truncated');
    twin.cache.meta.data = null;
    const served = await twin.loadMeta();
    served.documents.push({ id: 'scratch' });
    expect(twin.DEFAULT_META.documents).toEqual([]);
    // Absent file initializes.
    await rm(path);
    twin.cache.meta.data = null;
    await twin.updateSettings({ maxContextTokens: 2 });
    expect(JSON.parse(await readFile(path, 'utf8')).settings.maxContextTokens).toBe(2);
  });

  it('genome metadata keeps saved markers and refuses an upload that cannot record itself', async () => {
    const genome = await import('./genome.js');
    const path = join(PATHS.meatspace, 'genome.json');
    const rawPath = join(PATHS.meatspace, 'genome-raw.txt');
    const seed = JSON.stringify({ uploaded: true, filename: 'mine.txt', savedMarkers: { rs1: { notes: 'keep' } } });
    const tsv = Array.from({ length: 120 }, (_, i) => `rs${i + 1}\t1\t${i + 1}\tAA`).join('\n');
    await write(rawPath, 'original raw bytes');
    for (const bytes of ['{truncated', '', seed]) {
      await write(path, bytes);
      disk.fault = bytes === seed ? path : null;
      await expect(genome.uploadGenome(tsv, 'new.txt')).rejects.toThrow(unreadable);
      await expect(genome.saveMarker({ rsid: 'rs9', name: 'New', category: 'c', genotype: 'AA' })).rejects.toThrow(unreadable);
      disk.fault = null;
      expect(await readFile(path, 'utf8')).toBe(bytes);
      expect(await readFile(rawPath, 'utf8')).toBe('original raw bytes');
    }
    await write(path, seed);
    await genome.uploadGenome(tsv, 'new.txt');
    const saved = JSON.parse(await readFile(path, 'utf8'));
    expect(saved).toMatchObject({ uploaded: true, filename: 'new.txt', savedMarkers: { rs1: { notes: 'keep' } } });
    disk.fault = path;
    disk.once = true;
    await expect(genome.saveMarker({ rsid: 'rs9', name: 'New', category: 'c', genotype: 'AA' })).rejects.toThrow(unreadable);
    expect(JSON.parse(await readFile(path, 'utf8')).savedMarkers).toEqual({ rs1: { notes: 'keep' } });
    await rm(path);
    await genome.uploadGenome(tsv, 'fresh.txt');
    expect(JSON.parse(await readFile(path, 'utf8')).filename).toBe('fresh.txt');
  });

  describe('CoS agent index', () => {
    let index;
    const agentsDir = () => join(PATHS.cos, 'agents');
    const indexPath = () => join(agentsDir(), 'index.json');

    beforeEach(async () => {
      vi.resetModules();
      await rm(agentsDir(), { recursive: true, force: true });
      await mkdir(join(agentsDir(), '2026-10-01', 'agent-a'), { recursive: true });
      await mkdir(join(agentsDir(), '2026-10-02', 'agent-b'), { recursive: true });
      index = await import('./cosAgentIndex.js');
    });

    it('rebuilds a malformed index from the date buckets and never saves an empty map', async () => {
      for (const bytes of ['{truncated', '', '[]']) {
        vi.resetModules();
        index = await import('./cosAgentIndex.js');
        await write(indexPath(), bytes);
        const loaded = await index.loadAgentIndex();
        expect([...loaded.entries()].sort()).toEqual([['agent-a', '2026-10-01'], ['agent-b', '2026-10-02']]);
        // Loading is read-only: the bytes stay until a mutation persists the rebuilt map.
        expect(await readFile(indexPath(), 'utf8')).toBe(bytes);
        expect(await index.addAgentArchivesToIndex([{ agentId: 'agent-c', date: '2026-10-03' }])).toBe(1);
        expect(JSON.parse(await readFile(indexPath(), 'utf8'))).toEqual({
          'agent-a': '2026-10-01', 'agent-b': '2026-10-02', 'agent-c': '2026-10-03'
        });
      }
    });

    it('rebuilds instead of trusting an index it cannot read, and loads a healthy one verbatim', async () => {
      const healthy = { 'agent-a': '2026-10-01', 'agent-z': '2026-09-30' };
      await write(indexPath(), JSON.stringify(healthy));
      disk.fault = indexPath();
      expect([...(await index.loadAgentIndex()).keys()].sort()).toEqual(['agent-a', 'agent-b']);
      disk.fault = null;
      vi.resetModules();
      index = await import('./cosAgentIndex.js');
      expect(Object.fromEntries(await index.loadAgentIndex())).toEqual(healthy);
      expect(JSON.parse(await readFile(indexPath(), 'utf8'))).toEqual(healthy);
    });

    it('still builds the index when none exists', async () => {
      await rm(indexPath(), { force: true });
      expect([...(await index.loadAgentIndex()).keys()].sort()).toEqual(['agent-a', 'agent-b']);
      expect(Object.keys(JSON.parse(await readFile(indexPath(), 'utf8'))).sort()).toEqual(['agent-a', 'agent-b']);
    });
  });
});
