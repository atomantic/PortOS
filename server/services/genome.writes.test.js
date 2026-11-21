import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

vi.mock('../lib/paths.js', async importOriginal => {
  const { makePathsProxy, lazyTempDataRoot } = await import('../lib/mockPathsDataRoot.js');
  return makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-genome-writes-') });
});

const { cleanupTempDataRoots } = await import('../lib/mockPathsDataRoot.js');
const { PATHS, atomicWrite } = await import('../lib/fileUtils.js');
const { saveMarker, updateMarkerNotes, scanCuratedMarkers, getSnpIndex, uploadGenome, deleteMarker } = await import('./genome.js');

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
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await writeFile(META(), '{not json');
      await expect(saveMarker(marker('rsZ'))).rejects.toThrow();
      expect(await readFile(META(), 'utf8')).toBe('{not json');
      expect(error.mock.calls).toEqual([['❌ Genome metadata is unreadable or malformed']]);
    } finally {
      error.mockRestore();
    }
  });
});

describe('genome operational logs', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reports upload and scan counts without the filename or resolved APOE values', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const filename = 'example-person-genome.txt';
    const rows = Array.from({ length: 100 }, (_, i) => `rs${i + 1}\t1\t1\tAA`);
    const content = ['# build 37', ...rows, 'rs429358\t19\t1\tCC', 'rs7412\t19\t2\tCC'].join('\n');

    await expect(uploadGenome(content, filename)).resolves.toMatchObject({ filename, snpCount: 102 });
    const { markers } = await scanCuratedMarkers();
    const apoe = markers.find(({ rsid }) => rsid === 'apoe_haplotype');
    expect(apoe?.genotype).toBe('ε4/ε4');
    expect(apoe.description).toContain('~12x');

    expect(log).toHaveBeenCalledWith('🧬 Genome uploaded: 102 SNPs, Build 37');
    expect(log).toHaveBeenCalledWith(`🧬 Curated scan complete: ${markers.length} markers classified`);
    const logged = log.mock.calls.flat().join('\n');
    expect(logged).not.toContain(filename);
    expect(logged).not.toContain(apoe.genotype);
    expect(logged).not.toContain('~12x');
  });

  it('omits user-supplied marker fields from mutation logs', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { id } = await saveMarker(marker('rsExample', { name: 'Example private marker' }));
    await updateMarkerNotes(id, 'Example private note');
    await deleteMarker(id);
    expect(log.mock.calls).toEqual([
      ['🧬 Marker saved'],
      ['🧬 Marker notes updated'],
      ['🧬 Marker deleted'],
    ]);
  });
});
