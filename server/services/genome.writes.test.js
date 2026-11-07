import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

vi.mock('../lib/paths.js', async importOriginal => {
  const { makePathsProxy, lazyTempDataRoot } = await import('../lib/mockPathsDataRoot.js');
  return makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-genome-writes-') });
});

const { cleanupTempDataRoots } = await import('../lib/mockPathsDataRoot.js');
const { PATHS, atomicWrite } = await import('../lib/fileUtils.js');
const { saveMarker, updateMarkerNotes, scanCuratedMarkers, getSnpIndex } = await import('./genome.js');

const META = () => join(PATHS.meatspace, 'genome.json');
const readMeta = async () => JSON.parse(await readFile(META(), 'utf8'));
const marker = (rsid, extra = {}) => ({ rsid, genotype: 'AA', name: rsid, category: 'test', ...extra });

beforeEach(async () => {
  await rm(PATHS.meatspace, { recursive: true, force: true });
  await mkdir(PATHS.meatspace, { recursive: true });
  await atomicWrite(join(PATHS.meatspace, 'genome-raw.txt'), 'rs1\t1\t1\tAA\n');
  await atomicWrite(META(), { uploaded: true, savedMarkers: {}, lastScanAt: null });
});
afterAll(cleanupTempDataRoots);

describe('genome metadata writes are serialized', () => {
  it('keeps every marker from overlapping saveMarker calls, including cold-index lookups', async () => {
    await Promise.all([
      saveMarker({ rsid: 'rs1', name: 'one', category: 'test' }),
      saveMarker(marker('rs2')),
      saveMarker(marker('rs3'))
    ]);
    const rsids = Object.values((await readMeta()).savedMarkers).map(m => m.rsid).sort();
    expect(rsids).toEqual(['rs1', 'rs2', 'rs3']);
  });

  it('keeps a note edit that overlaps a slow saveMarker and a curated scan', async () => {
    const { id } = await saveMarker(marker('rsA'));
    await Promise.all([
      saveMarker({ rsid: 'rs1', name: 'cold', category: 'test' }),
      updateMarkerNotes(id, 'typed note'),
      scanCuratedMarkers()
    ]);
    const saved = Object.values((await readMeta()).savedMarkers);
    expect(saved.find(m => m.rsid === 'rsA').notes).toBe('typed note');
    expect(saved.some(m => m.rsid === 'rs1')).toBe(true);
    expect(await getSnpIndex()).toBeTruthy();
  });

  it('still refuses mutations when the metadata file is unreadable', async () => {
    await writeFile(META(), '{not json');
    await expect(saveMarker(marker('rsZ'))).rejects.toThrow();
    expect(await readFile(META(), 'utf8')).toBe('{not json');
  });
});
