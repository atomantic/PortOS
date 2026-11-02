import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

vi.mock('../lib/paths.js', async importOriginal => {
  const { makePathsProxy, lazyTempDataRoot } = await import('../lib/mockPathsDataRoot.js');
  return makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-genome-deletion-') });
});
vi.mock('./mortalLoomStore.js', () => ({
  isMortalLoomEnabled: vi.fn(async () => false),
  mlArrayIfEnabled: vi.fn(async () => null),
  mlReplace: vi.fn()
}));

const { cleanupTempDataRoots } = await import('../lib/mockPathsDataRoot.js');
const { PATHS, atomicWrite } = await import('../lib/fileUtils.js');
const { holdsBackupAssetPublication } = await import('../lib/backupSnapshotBoundary.js');
const { deleteGenome, getGenomeSummary, getSnpIndex } = await import('./genome.js');
const { deriveChronotype, getChronotype } = await import('./identity/chronotype.js');
const { deriveLongevity, getLongevity } = await import('./identity/longevity.js');
const { CHRONOTYPE_FILE, LONGEVITY_FILE, GOALS_FILE } = await import('./identity/store.js');
const { meatspaceEvents } = await import('./meatspaceEvents.js');

const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));
const behavioralData = { preferredWakeTime: '06:00', preferredSleepTime: '22:00', notes: 'Synthetic preference' };
let originalGoals;

beforeEach(async () => {
  await rm(PATHS.digitalTwin, { recursive: true, force: true });
  await mkdir(PATHS.digitalTwin, { recursive: true });
  await rm(PATHS.meatspace, { recursive: true, force: true });
  await mkdir(PATHS.meatspace, { recursive: true });
  originalGoals = {
    birthDate: '2000-01-01',
    goals: [{ id: 'synthetic-goal', title: 'Learn an instrument', status: 'active' }],
    lifeExpectancy: { adjusted: 87.5, longevityAdjustment: 5, cardiovascularAdjustment: 4 },
    timeHorizons: { yearsRemaining: 60 },
    updatedAt: '2026-01-01T00:00:00.000Z'
  };
  await atomicWrite(GOALS_FILE, originalGoals);
  await atomicWrite(CHRONOTYPE_FILE, { behavioralData });
  await atomicWrite(join(PATHS.meatspace, 'genome-raw.txt'), 'rs4753426\t11\t1\tGG\n');
  await atomicWrite(join(PATHS.meatspace, 'genome.json'), {
    uploaded: true,
    savedMarkers: Object.fromEntries([
      ['rs4753426', 'concern'], ['rs762551', 'concern'],
      ['rs2802292', 'beneficial'], ['rs1333049', 'concern']
    ].map(([rsid, status]) => [rsid, { rsid, genotype: 'GG', status }]))
  });
  await deriveChronotype();
  await deriveLongevity();
});
afterAll(cleanupTempDataRoots);

describe('genome deletion erases derived identity', () => {
  it('persists marker-free scores and recommendations, preserving behavioral inputs and goals', async () => {
    expect((await getChronotype()).recommendations.lastMealCutoff).toBe('19:00');
    expect((await getLongevity()).longevityScore).not.toBe(0);
    expect((await getLongevity()).cardiovascularRisk).not.toBe(0);
    expect((await getSnpIndex()).size).toBe(1);
    const onLongevity = vi.fn(() => expect(holdsBackupAssetPublication()).toBe(true));
    meatspaceEvents.on('death-clock:changed', onLongevity);
    try {
      await expect(deleteGenome()).resolves.toEqual({ success: true });
    } finally {
      meatspaceEvents.off('death-clock:changed', onLongevity);
    }
    expect(onLongevity).toHaveBeenCalledOnce();
    expect(await getGenomeSummary()).toEqual({ uploaded: false });
    expect(await getSnpIndex()).toBeNull();
    const chronotype = await getChronotype();
    expect(chronotype).toMatchObject({
      geneticMarkers: {}, caffeineMarkers: {}, behavioralData,
      type: 'morning', confidence: 0.3,
      scores: { genetic: 0, behavioral: -0.75, composite: -0.75 },
      recommendations: { caffeineCutoff: '14:00', lastMealCutoff: '20:30' }
    });
    expect(Object.keys(chronotype.geneticMarkers)).toHaveLength(0);
    expect(Object.keys(chronotype.caffeineMarkers)).toHaveLength(0);
    expect(await readJSON(CHRONOTYPE_FILE)).toEqual(chronotype);
    const longevity = await getLongevity();
    expect(longevity).toMatchObject({
      longevityMarkers: {}, cardiovascularMarkers: {}, longevityScore: 0,
      cardiovascularRisk: 0, confidence: 0,
      lifeExpectancy: { adjusted: 78.5, longevityAdjustment: 0, cardiovascularAdjustment: 0 }
    });
    expect(Object.keys(longevity.longevityMarkers)).toHaveLength(0);
    expect(Object.keys(longevity.cardiovascularMarkers)).toHaveLength(0);
    expect((await readJSON(LONGEVITY_FILE)).lifeExpectancy).toEqual(longevity.lifeExpectancy);
    expect(await readJSON(GOALS_FILE)).toEqual({ ...originalGoals, lifeExpectancy: null, timeHorizons: null });
    // A repeated deletion must also succeed when the raw files are already gone.
    await expect(deleteGenome()).resolves.toEqual({ success: true });
    expect((await getChronotype()).behavioralData).toEqual(behavioralData);
  });

  it('refuses success when the raw genome cannot be removed', async () => {
    const rawFile = join(PATHS.meatspace, 'genome-raw.txt');
    await rm(rawFile);
    await mkdir(rawFile);
    await expect(deleteGenome()).rejects.toThrow();
    expect((await getGenomeSummary()).uploaded).toBe(true);
    expect(Object.keys((await getChronotype()).geneticMarkers)).not.toHaveLength(0);
    await rm(rawFile, { recursive: true });
  });

  it('reports a derived-store read failure instead of replacing behavioral data with defaults', async () => {
    await writeFile(CHRONOTYPE_FILE, '{broken');
    await expect(deleteGenome()).rejects.toMatchObject({ code: 'UNREADABLE_STORE' });
    expect(await readFile(CHRONOTYPE_FILE, 'utf8')).toBe('{broken');
  });
});
