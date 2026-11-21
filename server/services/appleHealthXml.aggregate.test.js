/**
 * Re-importing a newer export must not inflate daily step/sleep totals when a
 * flush boundary falls inside a day (#17312). Runs the real importer against a
 * temporary health store and reads totals back through the query layer.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';

const dataRoot = mkdtempSync(join(tmpdir(), 'portos-health-agg-'));
vi.mock('../lib/fileUtils.js', async () =>
  makePathsProxy(await vi.importActual('../lib/fileUtils.js'), { dataRoot }));

const { PATHS } = await import('../lib/fileUtils.js');
const { ingestHealthData, readDayFile, writeDayFile } = await import('./appleHealthIngest.js');
const { importAppleHealthXml } = await import('./appleHealthXml.js');
const { getDailyAggregates } = await import('./appleHealthQuery.js');

const day = '2026-01-02';
// The parser hands records over one stream chunk (64KiB) at a time and the
// importer only flushes between chunks, so a flush can land inside a day only
// when the day's records span several chunks. Prepending a different number of
// filler records shifts where each chunk boundary falls, like a newer export.
const FLUSH = 1;
const STEPS = 1200;

const second = (i) => `${String(8 + Math.floor(i / 3600)).padStart(2, '0')}:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`;
const hr = (n) => Array.from({ length: n }, (_, i) =>
  `<Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min" startDate="2026-01-01 00:00:${String(i % 60).padStart(2, '0')} +0000" value="${60 + (i % 20)}"/>`).join('\n');
const steps = (n, src = 'Watch') => Array.from({ length: n }, (_, i) =>
  `<Record type="HKQuantityTypeIdentifierStepCount" sourceName="${src}" unit="count" startDate="${day} ${second(i)} +0000" value="1"/>`).join('\n');
// One-minute Core sleep stages.
const sleep = (n) => Array.from({ length: n }, (_, i) =>
  `<Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" startDate="${day} ${second(i)} +0000" endDate="${day} ${second(i + 60)} +0000" value="HKCategoryValueSleepAnalysisAsleepCore"/>`).join('\n');

async function importXml(body, flushInterval = FLUSH) {
  const path = join(dataRoot, 'export.xml');
  await writeFile(path, `<HealthData>\n${body}\n</HealthData>`);
  await importAppleHealthXml(path, null, { flushInterval });
}
const total = async (metric) => (await getDailyAggregates(metric, day, day))[0]?.value;

beforeEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
  await mkdir(PATHS.health, { recursive: true });
});
afterAll(() => rm(dataRoot, { recursive: true, force: true }));

describe('XML step/sleep aggregation across flush boundaries', () => {
  it('stores one step aggregate per source when flushes land inside the day', async () => {
    await importXml(`${hr(100)}\n${steps(STEPS)}`);
    expect((await readDayFile(day)).metrics.step_count).toHaveLength(1);
    expect(await total('step_count')).toBe(STEPS);
  });

  it('keeps the true step total when a newer export shifts the boundary', async () => {
    for (const filler of [100, 250, 400]) await importXml(`${hr(filler)}\n${steps(STEPS)}`);
    expect((await readDayFile(day)).metrics.step_count).toHaveLength(1);
    expect(await total('step_count')).toBe(STEPS);
  });

  it('keeps the true sleep total when a newer export shifts the boundary', async () => {
    for (const filler of [100, 400]) await importXml(`${hr(filler)}\n${sleep(STEPS)}`);
    expect((await readDayFile(day)).metrics.sleep_analysis).toHaveLength(1);
    expect(await total('sleep_analysis')).toBeCloseTo(STEPS / 60, 5);
  });

  it('repairs a day file that already holds stranded XML partials', async () => {
    const xml = (qty, date) => ({ date, qty, unit: 'count', src: 'Watch', origin: 'xml' });
    await writeDayFile(day, {
      date: day,
      metrics: { step_count: [xml(1067, `${day} 00:00:00 +0000`), xml(1903, `${day} 00:34:57 +0000`), xml(2933, `${day} 00:17:47 +0000`)] },
    });
    expect(await total('step_count')).toBe(5903);
    await importXml(steps(4000), 100);
    expect((await readDayFile(day)).metrics.step_count).toHaveLength(1);
    expect(await total('step_count')).toBe(4000);
  });

  it('leaves HAE points and other XML sources untouched', async () => {
    await ingestHealthData({ data: { metrics: [{ name: 'step_count', data: [{ date: `${day} 09:00:00 +0000`, qty: 777 }] }] } });
    await importXml(`${steps(500, 'Phone')}\n${steps(300, 'Watch')}`, 2);
    await importXml(steps(400, 'Watch'), 2);
    const stored = (await readDayFile(day)).metrics.step_count;
    expect(stored).toHaveLength(3);
    expect(stored).toEqual(expect.arrayContaining([
      expect.objectContaining({ origin: 'hae', qty: 777 }),
      expect.objectContaining({ origin: 'xml', src: 'Phone', qty: 500 }),
      expect.objectContaining({ origin: 'xml', src: 'Watch', qty: 400 }),
    ]));
  });
});
