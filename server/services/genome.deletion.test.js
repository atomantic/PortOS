import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
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
const { holdsBackupAssetPublication, acquireBackupSnapshotCut } = await import('../lib/backupSnapshotBoundary.js');
const { deleteGenome, getGenomeSummary, getSnpIndex } = await import('./genome.js');
const { deriveChronotype, getChronotype } = await import('./identity/chronotype.js');
const { deriveLongevity, getLongevity } = await import('./identity/longevity.js');
const { CHRONOTYPE_FILE, LONGEVITY_FILE, GOALS_FILE } = await import('./identity/store.js');
const { getCrossDomainNarrative } = await import('./insightsService.js');
const { createSnapshot, getSnapshot, listSnapshots } = await import('./timeCapsule.js');
const { meatspaceEvents } = await import('./meatspace/meatspaceEvents.js');

const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));
const behavioralData = { preferredWakeTime: '06:00', preferredSleepTime: '22:00', notes: 'Synthetic preference' };
const insightsDir = () => join(PATHS.data, 'insights');
const narrativeFile = () => join(insightsDir(), 'narrative.json');
const snapshotsDir = () => join(PATHS.digitalTwin, 'snapshots');
const snapshotsIndexFile = () => join(snapshotsDir(), 'index.json');
let originalGoals;

beforeEach(async () => {
  await rm(PATHS.digitalTwin, { recursive: true, force: true });
  await mkdir(PATHS.digitalTwin, { recursive: true });
  await rm(PATHS.meatspace, { recursive: true, force: true });
  await mkdir(PATHS.meatspace, { recursive: true });
  await rm(insightsDir(), { recursive: true, force: true });
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
    filename: 'synthetic-23andme-export.txt',
    snpCount: 4,
    build: 'Build 37',
    savedMarkers: Object.fromEntries([
      ['rs4753426', 'concern'], ['rs762551', 'concern'],
      ['rs2802292', 'beneficial'], ['rs1333049', 'concern']
    ].map(([rsid, status]) => [rsid, { rsid, genotype: 'GG', status, notes: `note-${rsid}` }]))
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
    const goalsAfter = await readJSON(GOALS_FILE);
    // The document clock advances so the clears win a peer's metadata LWW merge.
    expect(Date.parse(goalsAfter.updatedAt)).toBeGreaterThan(Date.parse(originalGoals.updatedAt));
    expect(goalsAfter).toEqual({ ...originalGoals, lifeExpectancy: null, timeHorizons: null, updatedAt: goalsAfter.updatedAt });
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
    await rm(rawFile, { recursive: true });
  });

  it('retains the source genome when a derived snapshot cannot be written', async () => {
    await rm(LONGEVITY_FILE);
    await mkdir(LONGEVITY_FILE);
    await expect(deleteGenome()).rejects.toThrow();
    expect((await getGenomeSummary()).uploaded).toBe(true);
    expect(await readFile(join(PATHS.meatspace, 'genome-raw.txt'), 'utf8')).toContain('rs4753426');
    expect(await readJSON(GOALS_FILE)).toEqual(originalGoals);
  });

  it('reports a derived-store read failure instead of replacing behavioral data with defaults', async () => {
    await writeFile(CHRONOTYPE_FILE, '{broken');
    await expect(deleteGenome()).rejects.toMatchObject({ code: 'UNREADABLE_STORE' });
    expect(await readFile(CHRONOTYPE_FILE, 'utf8')).toBe('{broken');
    expect((await getGenomeSummary()).uploaded).toBe(true);
    expect(await readFile(join(PATHS.meatspace, 'genome-raw.txt'), 'utf8')).toContain('rs4753426');
  });

  it('removes insights/narrative.json and strips genome markers from existing Time Capsule snapshots', async () => {
    await atomicWrite(narrativeFile(), {
      text: 'Your genome markers (rs4753426, rs2802292) correlate with evening preferences.',
      previousText: 'Prior narrative mentioning rs762551.',
      generatedAt: '2026-01-02T00:00:00.000Z',
      previousGeneratedAt: '2026-01-01T00:00:00.000Z',
      model: 'example-model'
    });

    // Create a current-format snapshot while genome is uploaded.
    const recent = await createSnapshot('post-upload');
    expect(recent.summary.genomeMarkers).toBe(4);
    const recentBefore = await getSnapshot(recent.id);
    expect(recentBefore.data['genome.json'].savedMarkers).toBeUndefined();
    expect(recentBefore.data['genome.json'].filename).toBeUndefined();
    expect(Object.keys(recentBefore.data['chronotype.json'].geneticMarkers)).not.toHaveLength(0);
    expect(Object.keys(recentBefore.data['longevity.json'].longevityMarkers)).not.toHaveLength(0);

    // Seed a legacy snapshot retaining full genome.json with savedMarkers and upload filename.
    const legacyId = '11111111-2222-3333-4444-555555555555';
    const legacyData = {
      'genome.json': {
        uploaded: true,
        filename: 'legacy-23andme-export.txt',
        savedMarkers: {
          rs4753426: { rsid: 'rs4753426', genotype: 'GG', status: 'concern', notes: 'legacy-note' }
        }
      },
      'chronotype.json': await readJSON(CHRONOTYPE_FILE),
      'longevity.json': await readJSON(LONGEVITY_FILE),
      'goals.json': originalGoals,
      'identity.json': { name: 'Example Twin' }
    };
    const legacyDataString = JSON.stringify(legacyData);
    const legacyMeta = {
      id: legacyId,
      label: 'legacy-with-genome',
      description: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      dataHash: createHash('sha256').update(legacyDataString).digest('hex').slice(0, 16),
      sizeBytes: Buffer.byteLength(legacyDataString, 'utf-8'),
      summary: {
        documentCount: 0,
        enabledDocuments: 0,
        markdownFiles: 0,
        goalsCount: 1,
        storiesCount: 0,
        genomeMarkers: 1,
        hasIdentity: true,
        testHistoryCount: 0,
        traits: null,
        confidenceScores: null
      }
    };
    await atomicWrite(join(snapshotsDir(), `${legacyId}.json`), { ...legacyMeta, data: legacyData });
    const preIndex = await readJSON(snapshotsIndexFile());
    preIndex.snapshots.push(legacyMeta);
    await atomicWrite(snapshotsIndexFile(), preIndex);

    await expect(deleteGenome()).resolves.toEqual({ success: true });

    // Narrative cache is removed idempotently.
    expect(existsSync(narrativeFile())).toBe(false);
    expect(await getCrossDomainNarrative()).toEqual({ available: false, reason: 'not_generated' });

    // Both snapshots are stripped on disk and refreshed in snapshots/index.json.
    const listed = await listSnapshots();
    expect(listed.map(s => s.id)).toEqual([recent.id, legacyId]);

    for (const id of [recent.id, legacyId]) {
      const snap = await getSnapshot(id);
      const indexEntry = listed.find(s => s.id === id);
      const serializedData = JSON.stringify(snap.data);
      const expectedHash = createHash('sha256').update(serializedData).digest('hex').slice(0, 16);
      const expectedSize = Buffer.byteLength(serializedData, 'utf-8');

      expect(snap.data['genome.json']).toBeUndefined();
      expect(snap.data['chronotype.json'].geneticMarkers).toEqual({});
      expect(snap.data['chronotype.json'].caffeineMarkers).toEqual({});
      expect(snap.data['chronotype.json'].behavioralData).toEqual(behavioralData);
      expect(snap.data['longevity.json'].longevityMarkers).toEqual({});
      expect(snap.data['longevity.json'].cardiovascularMarkers).toEqual({});
      expect(snap.data['goals.json'].lifeExpectancy).toBeNull();
      expect(snap.data['goals.json'].timeHorizons).toBeNull();
      expect(snap.data['goals.json'].goals).toEqual(originalGoals.goals);
      expect(snap.data['goals.json'].birthDate).toBe(originalGoals.birthDate);

      expect(snap.summary.genomeMarkers).toBe(0);
      expect(snap.dataHash).toBe(expectedHash);
      expect(snap.sizeBytes).toBe(expectedSize);
      expect(indexEntry.summary.genomeMarkers).toBe(0);
      expect(indexEntry.dataHash).toBe(expectedHash);
      expect(indexEntry.sizeBytes).toBe(expectedSize);

      const rawSnapshotText = await readFile(join(snapshotsDir(), `${id}.json`), 'utf8');
      expect(rawSnapshotText).not.toContain('rs4753426');
      expect(rawSnapshotText).not.toContain('rs762551');
      expect(rawSnapshotText).not.toContain('rs2802292');
      expect(rawSnapshotText).not.toContain('rs1333049');
      expect(rawSnapshotText).not.toContain('legacy-23andme-export.txt');
      expect(rawSnapshotText).not.toContain('synthetic-23andme-export.txt');
      expect(rawSnapshotText).not.toContain('legacy-note');
    }

    // Repeated deletion remains idempotent with narrative absent and snapshots already clean.
    await expect(deleteGenome()).resolves.toEqual({ success: true });
    expect(existsSync(narrativeFile())).toBe(false);
  });

  it('retains the source genome if narrative.json cannot be removed', async () => {
    await mkdir(narrativeFile(), { recursive: true });
    await expect(deleteGenome()).rejects.toThrow();
    expect((await getGenomeSummary()).uploaded).toBe(true);
    expect(await readFile(join(PATHS.meatspace, 'genome-raw.txt'), 'utf8')).toContain('rs4753426');
  });

  it('retains the source genome if a Time Capsule snapshot is unreadable', async () => {
    await mkdir(snapshotsDir(), { recursive: true });
    await writeFile(join(snapshotsDir(), 'corrupt-snapshot.json'), '{broken');
    await expect(deleteGenome()).rejects.toMatchObject({ code: 'UNREADABLE_STORE' });
    expect((await getGenomeSummary()).uploaded).toBe(true);
    expect(await readFile(join(PATHS.meatspace, 'genome-raw.txt'), 'utf8')).toContain('rs4753426');
  });

  it('defers narrative removal and Time Capsule snapshot stripping while a backup cut is active', async () => {
    await atomicWrite(narrativeFile(), { text: 'Narrative with rs4753426', previousText: null });
    const snap = await createSnapshot('cut-guarded');
    expect(snap.summary.genomeMarkers).toBe(4);

    const release = await acquireBackupSnapshotCut();
    let deletion;
    try {
      deletion = deleteGenome();
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(existsSync(narrativeFile())).toBe(true);
      expect((await getSnapshot(snap.id)).summary.genomeMarkers).toBe(4);
      expect((await listSnapshots())[0].summary.genomeMarkers).toBe(4);
    } finally {
      release();
    }

    await expect(deletion).resolves.toEqual({ success: true });
    expect(existsSync(narrativeFile())).toBe(false);
    expect((await getSnapshot(snap.id)).summary.genomeMarkers).toBe(0);
    expect((await listSnapshots())[0].summary.genomeMarkers).toBe(0);
  });
});
