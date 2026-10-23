import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

const hooks = vi.hoisted(() => ({ afterRead: null }));
vi.mock('../lib/fileUtils.js', async (original) => {
  const actual = await original();
  return makePathsProxy(actual, {
    dataRoot: () => lazyTempDataRoot('portos-mortalloom-daily-import-'),
    overrides: {
      dataPath: (...parts) => join(lazyTempDataRoot('portos-mortalloom-daily-import-'), ...parts),
      readJSONFile: async (...args) => {
        const value = await actual.readJSONFile(...args);
        await hooks.afterRead?.(args[0]);
        return value;
      },
    },
  });
});
vi.mock('../lib/paths.js', async (original) => makePathsProxy(await original(), {
  dataRoot: () => lazyTempDataRoot('portos-mortalloom-daily-import-'),
}));
// iCloud sync stays OFF: every assertion reads the local stores the import must fill.
vi.mock('./settings.js', async () => {
  const { EventEmitter } = await import('events');
  return { settingsEvents: new EventEmitter(), getSettings: async () => ({
    mortalloom: { enabled: false, path: join(lazyTempDataRoot('portos-mortalloom-daily-import-'), 'source.json') },
  }) };
});
vi.mock('./genome.js', () => ({ getSnpIndex: async () => null }));

import { PATHS } from '../lib/fileUtils.js';
import { importToPortOS } from './mortalLoomStore.js';
import { getDailyAlcohol, logDrink, removeDrink } from './meatspaceAlcohol.js';
import { getDailyNicotine } from './meatspaceNicotine.js';
import { getBodyHistory } from './meatspaceHealth.js';
import { getConfig } from './meatspace.js';

const localPath = (name) => join(PATHS.meatspace, name);
async function seed(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}
const source = (value) => seed(join(PATHS.data, 'source.json'), value);
const read = async (name) => JSON.parse(await readFile(localPath(name), 'utf8'));
const beer = (id, date = '2026-01-02') => ({ id, date, name: 'Example beer', oz: 12, abv: 5, count: 1 });
const drinkIds = async () => (await getDailyAlcohol()).flatMap(entry => entry.alcohol.drinks.map(drink => drink.id));

beforeEach(async () => {
  hooks.afterRead = null;
  await rm(PATHS.data, { recursive: true, force: true });
  await mkdir(PATHS.data, { recursive: true });
});
afterAll(cleanupTempDataRoots);

it('imports daily records and the profile into the stores the normal readers use', async () => {
  await source({
    alcoholDrinks: [beer('ML-DRINK')],
    nicotineEntries: [{ id: 'ML-NIC', date: '2026-01-02', product: 'Example pouch', mgPerUnit: 6, count: 2 }],
    bodyEntries: [{ id: 'ML-BODY', date: '2026-01-02', weight: 180, bodyFat: 20 }],
    profile: { biologicalSex: 'female', birthDate: '1990-05-05', lifestyle: { sleepHoursPerNight: 8, bmi: 22 } },
  });
  await seed(localPath('daily-log.json'), {
    entries: [{ date: '2026-01-02', alcohol: { drinks: [{ id: 'local-drink', name: 'Example wine', oz: 5, abv: 12, count: 1 }], standardDrinks: 1 },
      body: { weight: 175 }, notes: 'Example tenant' }],
    lastEntryDate: '2026-01-02',
    eventTombstones: [{ id: 'gone', deletedAt: '2026-01-01T00:00:00.000Z' }],
  });
  await seed(localPath('config.json'), { birthDate: null, sex: null, lifestyle: { sleepHoursPerNight: 6 }, updatedAt: null });

  expect(await importToPortOS()).toMatchObject({
    ok: true,
    added: { alcoholDrinks: 1, nicotineEntries: 1, bodyEntries: 1, profile: 1 },
  });

  const [day] = await getDailyAlcohol();
  expect(day.alcohol.drinks.map(drink => drink.id)).toEqual(['local-drink', 'ML-DRINK']);
  // 5oz@12% = 1.0 + 12oz@5% = 1.0, recomputed from the retained list.
  expect(day.alcohol.standardDrinks).toBe(2);
  expect(day.notes).toBe('Example tenant');
  const [nicotineDay] = await getDailyNicotine();
  expect(nicotineDay.nicotine).toEqual({ items: [{ id: 'ML-NIC', product: 'Example pouch', mgPerUnit: 6, count: 2 }], totalMg: 12 });
  // Fill-only body: the local weight edit wins, the missing field is filled.
  expect(await getBodyHistory()).toEqual([{ date: '2026-01-02', weight: 175, bodyFat: 20 }]);
  const config = await getConfig();
  expect(config).toMatchObject({ sex: 'female', sexSource: 'mortalloom', birthDate: '1990-05-05' });
  expect(config.lifestyle).toEqual({ sleepHoursPerNight: 6, bmi: 22 });
  const log = await read('daily-log.json');
  expect(log.eventTombstones).toEqual([{ id: 'gone', deletedAt: '2026-01-01T00:00:00.000Z' }]);
  for (const legacy of ['alcohol-drinks.json', 'nicotine-entries.json', 'body-entries.json', 'profile.json']) {
    await expect(readFile(localPath(legacy), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  }
});

it('keeps native identity on retry: no duplicates, no resurrected deletions, equal content stays distinct', async () => {
  const idless = { date: '2026-01-03', name: 'Example cider', oz: 12, abv: 6, count: 1 };
  await source({ alcoholDrinks: [beer('ML-A'), beer('ML-B'), beer('ML-C'), idless, idless] });
  expect(await importToPortOS()).toMatchObject({ added: { alcoholDrinks: 5 }, skipped: { alcoholDrinks: 0 } });
  expect(await removeDrink('2026-01-02', 2)).toMatchObject({ id: 'ML-C' });

  expect(await importToPortOS()).toMatchObject({ added: { alcoholDrinks: 0 }, skipped: { alcoholDrinks: 5 } });
  const days = await getDailyAlcohol();
  expect(days.map(entry => [entry.date, entry.alcohol.drinks.length])).toEqual([['2026-01-03', 2], ['2026-01-02', 2]]);
  expect(await drinkIds()).toEqual([undefined, undefined, 'ML-A', 'ML-B']);
  expect(days.find(entry => entry.date === '2026-01-02').alcohol.standardDrinks).toBe(2);
});

it('keeps local writes and overlapping imports made after preflight', async () => {
  await source({ alcoholDrinks: [beer('ML-A')], profile: { biologicalSex: 'male' } });
  await seed(localPath('config.json'), { birthDate: '1980-01-01', sex: null, lifestyle: {} });
  let raced = false;
  hooks.afterRead = async (path) => {
    if (raced || path !== localPath('daily-log.json')) return;
    raced = true;
    await logDrink({ name: 'Example local', oz: 12, abv: 5, date: '2026-01-02' });
  };
  const reports = await Promise.all([importToPortOS(), importToPortOS()]);
  expect(reports.reduce((sum, report) => sum + report.added.alcoholDrinks, 0)).toBe(1);
  expect(reports.reduce((sum, report) => sum + report.added.profile, 0)).toBe(1);
  const [day] = await getDailyAlcohol();
  expect(day.alcohol.drinks.map(drink => drink.name).sort()).toEqual(['Example beer', 'Example local']);
  expect(day.alcohol.standardDrinks).toBe(2);
  expect(await getConfig()).toMatchObject({ sex: 'male', birthDate: '1980-01-01' });
});
