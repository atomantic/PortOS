import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

vi.mock('../lib/paths.js', async (importOriginal) => {
  const { makePathsProxy, lazyTempDataRoot } = await import('../lib/mockPathsDataRoot.js');
  return makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-twin-derived-sync-') });
});
vi.mock('./genome.js', () => ({ getGenomeSummary: vi.fn() }));
vi.mock('./mortalLoomStore.js', () => ({ mlArrayIfEnabled: vi.fn(async () => null) }));

const { cleanupTempDataRoots } = await import('../lib/mockPathsDataRoot.js');
const { atomicWrite, PATHS } = await import('../lib/fileUtils.js');
const { getGenomeSummary } = await import('./genome.js');
const { applyDigitalTwinRemote } = await import('./digital-twin-sync.js');
const { deriveChronotype, getChronotype, updateChronotypeBehavioral } = await import('./identity/chronotype.js');
const { deriveLongevity, getLongevity } = await import('./identity/longevity.js');
const { CHRONOTYPE_FILE, LONGEVITY_FILE, GOALS_FILE, IDENTITY_FILE } = await import('./identity/store.js');
const { meatspaceEvents } = await import('./meatspace/meatspaceEvents.js');

const earlier = '2026-01-01T00:00:00.000Z';
const later = '2026-01-02T00:00:00.000Z';
const genome = {
  uploaded: true,
  savedMarkers: Object.fromEntries([
    ['rs4753426', 'concern'],
    ['rs762551', 'concern'],
    ['rs2802292', 'beneficial'],
    ['rs1333049', 'concern'],
  ].map(([rsid, status]) => [rsid, { rsid, status, genotype: 'GG' }])),
};
const readJSON = async (path) => JSON.parse(await readFile(path, 'utf8'));

beforeEach(async () => {
  await rm(PATHS.digitalTwin, { recursive: true, force: true });
  await mkdir(PATHS.digitalTwin, { recursive: true });
  getGenomeSummary.mockReset().mockResolvedValue({ uploaded: false });
});
afterEach(() => vi.useRealTimers());
afterAll(cleanupTempDataRoots);

describe('derived Digital Twin peer sync', () => {
  it.skipIf(process.platform === 'win32')('rewrites peer identity and observed evidence with owner-only permissions', async () => {
    const chronotypeObservedFile = join(PATHS.digitalTwin, 'chronotype-observed.json');
    const tasteObservedFile = join(PATHS.digitalTwin, 'taste-observed.json');
    const files = [IDENTITY_FILE, CHRONOTYPE_FILE, LONGEVITY_FILE, chronotypeObservedFile, tasteObservedFile];
    for (const file of files) {
      await writeFile(file, '{}');
      await chmod(file, 0o644);
    }
    await expect(applyDigitalTwinRemote({
      identity: { name: 'Example Twin', updatedAt: later },
      chronotype: { derivedAt: later, behavioralData: { preferredWakeTime: '10:00' } },
      longevity: { derivedAt: later, lifeExpectancy: { adjusted: 80 } },
      chronotypeObserved: { derivedAt: later, sampleSize: 8 },
      tasteObserved: { derivedAt: later, windows: { month: { listen: { total: 4 } } } },
    })).resolves.toEqual({ applied: true, count: 5 });
    for (const file of files) expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('replaces newer idle defaults with coherent genome-derived snapshots and preserves the change event', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(earlier);
    getGenomeSummary.mockResolvedValue(genome);
    const chronotype = await updateChronotypeBehavioral({ preferredWakeTime: '10:00' });
    const longevity = await deriveLongevity('2000-01-01');

    await rm(CHRONOTYPE_FILE);
    await rm(LONGEVITY_FILE);
    vi.setSystemTime(later);
    getGenomeSummary.mockResolvedValue({ uploaded: false });
    await atomicWrite(GOALS_FILE, { birthDate: '2000-01-01' });
    const idleChronotype = await getChronotype();
    const idleLongevity = await getLongevity();
    expect(idleChronotype.type).toBe('intermediate');
    expect(idleLongevity.lifeExpectancy.adjusted).toBe(78.5);
    expect(idleLongevity.timeHorizons).toBeTruthy();

    const onLongevity = vi.fn();
    meatspaceEvents.on('death-clock:changed', onLongevity);
    try {
      await expect(applyDigitalTwinRemote({ chronotype, longevity })).resolves.toEqual({ applied: true, count: 2 });
      expect(await readJSON(CHRONOTYPE_FILE)).toEqual(chronotype);
      expect(await readJSON(LONGEVITY_FILE)).toEqual(longevity);
      expect(chronotype.recommendations.caffeineCutoff).toBe('12:00');
      expect(longevity.lifeExpectancy.adjusted).toBe(79.5);
      await expect(applyDigitalTwinRemote({ chronotype: idleChronotype, longevity: idleLongevity }))
        .resolves.toEqual({ applied: false, count: 0 });
      expect(onLongevity).toHaveBeenCalledOnce();
    } finally {
      meatspaceEvents.off('death-clock:changed', onLongevity);
    }
  });

  it('propagates a behavioral edit wholesale using the actual instant of each derivation', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime('2026-01-02T00:30:00.000Z');
    const original = await updateChronotypeBehavioral({ preferredWakeTime: '06:00', preferredSleepTime: '21:00' });
    vi.setSystemTime('2026-01-02T01:30:00.000Z');
    const edited = await updateChronotypeBehavioral({ preferredWakeTime: '10:00', preferredSleepTime: '01:00' });
    expect(edited.type).toBe('evening');
    expect(edited.scores.composite).toBe(1);

    await atomicWrite(CHRONOTYPE_FILE, { ...original, derivedAt: '2026-01-02T02:30:00+02:00' });
    await expect(applyDigitalTwinRemote({ chronotype: edited })).resolves.toEqual({ applied: true, count: 1 });
    expect(await getChronotype()).toEqual(edited);
  });

  it.each([
    ['chronotype', CHRONOTYPE_FILE, deriveChronotype],
    ['longevity', LONGEVITY_FILE, deriveLongevity],
  ])('serializes %s sync behind an in-flight local derivation', async (key, path, derive) => {
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    getGenomeSummary.mockImplementationOnce(async () => {
      started.resolve();
      await release.promise;
      return genome;
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(earlier);
    const localWrite = derive();
    await started.promise;

    const signal = key === 'chronotype' ? { geneticMarkers: { clockGene: {} } } : { longevityMarkers: { foxo3a: {} } };
    const remote = { derivedAt: later, ...signal };
    let sync;
    try {
      // A separate published file proves the sync has started while the derive is blocked.
      const identity = { updatedAt: later };
      sync = applyDigitalTwinRemote({ identity, [key]: remote });
      await vi.waitFor(async () => expect(await readJSON(IDENTITY_FILE)).toEqual(identity));
      await expect(readJSON(path)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      release.resolve();
      await Promise.all([localWrite, sync]);
    }
    expect(await readJSON(path)).toEqual(remote);
  });

  it('rejects a behavioral edit on unreadable storage and leaves the bytes intact', async () => {
    await writeFile(CHRONOTYPE_FILE, '{');
    await expect(updateChronotypeBehavioral({ preferredWakeTime: '10:00' }))
      .rejects.toMatchObject({ code: 'UNREADABLE_STORE' });
    expect(await readFile(CHRONOTYPE_FILE, 'utf8')).toBe('{');
  });

  it('propagates a newer genetics erasure to a peer and never resurrects peer markers (both directions)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(earlier);
    getGenomeSummary.mockResolvedValue(genome);
    await deriveChronotype();
    await deriveLongevity('2000-01-01');
    const peer = { chronotype: await readJSON(CHRONOTYPE_FILE), longevity: await readJSON(LONGEVITY_FILE) };
    expect(Object.keys(peer.longevity.longevityMarkers).length).toBeGreaterThan(0);

    vi.setSystemTime(later);
    await deriveChronotype({ withoutGenetics: true });
    await deriveLongevity(undefined, { withoutGenetics: true });
    const cleared = { chronotype: await readJSON(CHRONOTYPE_FILE), longevity: await readJSON(LONGEVITY_FILE) };
    expect(cleared.chronotype.geneticsClearedAt).toBe(later);
    expect(cleared.longevity.geneticsClearedAt).toBe(later);

    // Deleting machine pulls the stale peer: local erasure survives.
    await applyDigitalTwinRemote(peer);
    expect(await readJSON(CHRONOTYPE_FILE)).toEqual(cleared.chronotype);
    expect(await readJSON(LONGEVITY_FILE)).toEqual(cleared.longevity);

    // Peer pulls the erased snapshot: erasure wins over its populated record.
    await writeFile(CHRONOTYPE_FILE, JSON.stringify(peer.chronotype));
    await writeFile(LONGEVITY_FILE, JSON.stringify(peer.longevity));
    await applyDigitalTwinRemote(cleared);
    expect(await readJSON(CHRONOTYPE_FILE)).toEqual(cleared.chronotype);
    expect(await readJSON(LONGEVITY_FILE)).toEqual(cleared.longevity);
  });
});
