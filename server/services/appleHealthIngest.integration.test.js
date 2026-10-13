import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';

const dataRoot = mkdtempSync(join(tmpdir(), 'portos-health-replay-'));
vi.mock('../lib/fileUtils.js', async () =>
  makePathsProxy(await vi.importActual('../lib/fileUtils.js'), { dataRoot }));

const { PATHS } = await import('../lib/fileUtils.js');
const { ingestHealthData, readDayFile } = await import('./appleHealthIngest.js');
const { importAppleHealthXml } = await import('./appleHealthXml.js');
const { getDailyAggregates } = await import('./appleHealthQuery.js');

const day = '2026-01-02';
const timestamp = `${day} 08:00:00 +0000`;
const payload = (name, data) => ({ data: { metrics: [{ name, data }] } });
const aggregate = (metric) => getDailyAggregates(metric, day, day);

async function importSteps(watch = 120) {
  const path = join(dataRoot, 'export.xml');
  await writeFile(path, `<HealthData>
    <Record type="HKQuantityTypeIdentifierStepCount" sourceName="Watch" unit="count" startDate="${timestamp}" value="${watch}"/>
    <Record type="HKQuantityTypeIdentifierStepCount" sourceName="Phone" unit="count" startDate="${timestamp}" value="80"/>
  </HealthData>`);
  await importAppleHealthXml(path);
}

beforeEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
  await mkdir(PATHS.health, { recursive: true });
});
afterAll(() => rm(dataRoot, { recursive: true, force: true }));

describe('health ingestion replay through stored daily aggregates', () => {
  it('preserves device observations and HAE precedence across XML reimports', async () => {
    await importSteps();
    expect(await aggregate('step_count')).toMatchObject([{ value: 120 }]);
    await importSteps();
    expect((await readDayFile(day)).metrics.step_count).toHaveLength(2);
    expect(await aggregate('step_count')).toMatchObject([{ value: 120 }]);

    // A correction replaces only the same device's observation.
    await importSteps(150);
    expect((await readDayFile(day)).metrics.step_count).toHaveLength(2);
    expect(await aggregate('step_count')).toMatchObject([{ value: 150 }]);

    await ingestHealthData(payload('step_count', [{ date: timestamp, qty: 200 }]));
    await importSteps(160);
    const stored = (await readDayFile(day)).metrics.step_count;
    expect(stored).toHaveLength(3);
    expect(stored).toEqual(expect.arrayContaining([
      expect.objectContaining({ origin: 'xml', src: 'Watch', qty: 160 }),
      expect.objectContaining({ origin: 'xml', src: 'Phone', qty: 80 }),
      expect.objectContaining({ origin: 'hae', qty: 200 }),
    ]));
    expect(await aggregate('step_count')).toMatchObject([{ value: 200 }]);
  });

  it('deduplicates fresh HAE batches and persists repair of existing duplicate points', async () => {
    const point = { date: timestamp, qty: 50 };
    const batch = payload('active_energy', [point, point, { ...point, qty: 60 }]);
    expect(await ingestHealthData(batch)).toMatchObject({ recordsIngested: 1, recordsUpdated: 1, recordsSkipped: 1 });
    expect((await readDayFile(day)).metrics.active_energy).toHaveLength(1);
    expect(await aggregate('active_energy')).toMatchObject([{ value: 60 }]);

    // Older versions persisted identical duplicates on the first batch and
    // skipped writing the canonical set when a later replay changed no value.
    const savedPoint = { ...point, origin: 'hae' };
    await writeFile(join(PATHS.health, `${day}.json`), JSON.stringify({
      date: day, metrics: { active_energy: [savedPoint, savedPoint] },
    }));
    const replay = payload('active_energy', [point, point]);
    expect(await ingestHealthData(replay)).toMatchObject({ recordsIngested: 0, recordsUpdated: 0, recordsSkipped: 2, daysAffected: 1 });
    expect((await readDayFile(day)).metrics.active_energy).toEqual([savedPoint]);
    expect(await aggregate('active_energy')).toMatchObject([{ value: 50 }]);
    expect(await ingestHealthData(replay)).toMatchObject({ recordsIngested: 0, recordsUpdated: 0, recordsSkipped: 2, daysAffected: 0 });
  });

  it('upgrades legacy origins without dropping a different source at the same timestamp', async () => {
    await writeFile(join(PATHS.health, `${day}.json`), JSON.stringify({
      date: day, metrics: { step_count: [
        { date: timestamp, qty: 100, src: 'Watch' },
        { date: timestamp, qty: 70, src: null },
        { date: timestamp, qty: 180 },
      ] },
    }));
    await importSteps(150);
    await ingestHealthData(payload('step_count', [{ date: timestamp, qty: 200 }]));
    const points = (await readDayFile(day)).metrics.step_count;
    expect(points).toHaveLength(4);
    expect(points).toEqual(expect.arrayContaining([
      expect.objectContaining({ origin: 'xml', src: 'Watch', qty: 150 }),
      expect.objectContaining({ src: null, qty: 70 }),
      expect.objectContaining({ origin: 'hae', qty: 200 }),
    ]));
    expect(await aggregate('step_count')).toMatchObject([{ value: 200 }]);
  });
});
