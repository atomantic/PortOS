/**
 * MortalLoom iCloud store adapter.
 *
 * When "Use MortalLoom iCloud" is enabled in PortOS Settings, this module is
 * the single source of truth for all shared reads and writes. Both this PortOS
 * server and the MortalLoom iOS/macOS app read/write the same MortalLoom.json
 * in the app's iCloud ubiquity container, so adding data on either side shows
 * up on the other after iCloud sync completes.
 */

import { homedir } from 'os';
import { join } from 'path';
import { readFile, writeFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { safeJSONParse, readJSONFile, dataPath, ensureDir } from '../lib/fileUtils.js';
import { getSettings } from './settings.js';

const DEFAULT_ICLOUD_PATH = join(
  homedir(),
  'Library/Mobile Documents/iCloud~net~shadowpuppet~MeatSpaceTracker/Documents/MortalLoom.json'
);

const APP_STORE_ID = '6760883701';
export const MORTALLOOM_APP_STORE_URL = `https://apps.apple.com/app/id${APP_STORE_ID}`;

const ARRAY_KEYS = [
  'alcoholDrinks', 'alcoholPresets', 'bloodTests', 'bodyEntries',
  'epigeneticTests', 'eyeExams', 'goals', 'habits', 'healthMetrics',
  'nicotineEntries', 'nicotinePresets', 'saunaPresets', 'saunaSessions'
];

export function defaultStorePath() { return DEFAULT_ICLOUD_PATH; }

// === Core I/O ===

async function resolvePath() {
  const s = await getSettings();
  return s?.mortalloom?.path?.trim() || DEFAULT_ICLOUD_PATH;
}

export async function isMortalLoomEnabled() {
  const s = await getSettings();
  return Boolean(s?.mortalloom?.enabled);
}

export async function readStore() {
  const path = await resolvePath();
  if (!existsSync(path)) return null;
  const raw = await readFile(path, 'utf-8');
  return safeJSONParse(raw, null, { context: path });
}

async function writeStore(data) {
  await writeFile(await resolvePath(), JSON.stringify(data, null, 2));
}

/** Atomic read → mutate → write. Ensures all array keys are initialized. */
export async function updateStore(mutator) {
  const store = (await readStore()) || {};
  for (const k of ARRAY_KEYS) if (!Array.isArray(store[k])) store[k] = [];
  const result = await mutator(store);
  await writeStore(store);
  return result;
}

/** Uppercase UUID v4 — matches MortalLoom's iOS/macOS id format. */
export const newMortalLoomId = () => randomUUID().toUpperCase();

// === High-level entity helpers ===

/** Push a new record (minted id if absent) onto an array key. Returns the stored record. */
export async function mlPush(key, record) {
  const stored = { id: newMortalLoomId(), ...record };
  await updateStore(store => { store[key].push(stored); });
  return stored;
}

export async function mlPatchById(key, id, updates) {
  return updateStore(store => {
    const item = store[key].find(r => r.id === id);
    if (!item) return null;
    Object.assign(item, updates);
    return item;
  });
}

export async function mlRemoveById(key, id) {
  return updateStore(store => {
    const i = store[key].findIndex(r => r.id === id);
    if (i < 0) return null;
    return store[key].splice(i, 1)[0];
  });
}

export async function mlReplace(key, array) {
  await updateStore(store => { store[key] = array; });
}

// === Profile (HealthProfile mirror: biologicalSex, birthDate, lifestyle, …) ===

/** Returns `store.profile` when MortalLoom sync is enabled, else null. */
export async function mlGetProfileIfEnabled() {
  if (!(await isMortalLoomEnabled())) return null;
  const store = await readStore();
  return (store && typeof store.profile === 'object') ? store.profile : null;
}

/**
 * Deep-merge `patch` onto `store.profile` when sync is enabled; no-op otherwise.
 * Nested objects (`lifestyle`, `locationProfile`, `socioeconomic`) are merged field-wise
 * so callers can patch a single field without clobbering the rest.
 */
export async function mlPatchProfileIfEnabled(patch) {
  if (!(await isMortalLoomEnabled())) return null;
  return updateStore(store => {
    const current = (store.profile && typeof store.profile === 'object') ? store.profile : {};
    const next = { ...current };
    for (const [k, v] of Object.entries(patch)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && current[k] && typeof current[k] === 'object') {
        next[k] = { ...current[k], ...v };
      } else {
        next[k] = v;
      }
    }
    store.profile = next;
    return next;
  });
}

/**
 * Upsert a HealthMetricEntry by date — merges non-null fields into the
 * existing entry for that date, or appends a new one. Mirrors Swift's
 * DataStore.upsertHealthMetric + HealthMetricEntry.mergeFields.
 */
export async function mlUpsertHealthMetricByDate(date, patch) {
  return updateStore(store => {
    const existing = store.healthMetrics.find(m => m.date === date);
    if (existing) {
      for (const [k, v] of Object.entries(patch)) {
        if (v !== undefined && v !== null) existing[k] = v;
      }
      return existing;
    }
    const created = { id: newMortalLoomId(), date, ...patch };
    store.healthMetrics.push(created);
    return created;
  });
}

/**
 * Alcohol/nicotine use (date, positional-index) addressing in the PortOS daily-log.
 * Return the id of the N-th record in store[key] with the given date (in stored order).
 */
export async function mlIdAtDateIndex(key, date, index) {
  const store = await readStore();
  if (!store || !Array.isArray(store[key])) return null;
  const sameDate = store[key].filter(r => r.date === date);
  return sameDate[index]?.id ?? null;
}

// === Read-side convenience ===

/** Returns an array for `key` from the store when enabled, else null (fall through to local). */
export async function mlArrayIfEnabled(key) {
  if (!(await isMortalLoomEnabled())) return null;
  const store = await readStore();
  if (!store || !Array.isArray(store[key])) return null;
  return store[key];
}

// === Daily-log composition (alcohol + nicotine records → day-keyed log) ===

export function buildDailyLogFromMortalLoom(store) {
  const empty = { entries: [], lastEntryDate: null };
  if (!store || typeof store !== 'object') return empty;

  const byDate = new Map();
  const entryFor = d => (byDate.get(d) ?? byDate.set(d, { date: d }).get(d));

  for (const d of (store.alcoholDrinks || [])) {
    if (!d?.date) continue;
    const e = entryFor(d.date);
    if (!e.alcohol) e.alcohol = { drinks: [], standardDrinks: 0 };
    const oz = Number(d.oz) || 0, abv = Number(d.abv) || 0, count = Number(d.count) || 1;
    e.alcohol.drinks.push({ name: d.name || '', oz, abv, count });
    e.alcohol.standardDrinks = Math.round((e.alcohol.standardDrinks + (oz * count * (abv / 100)) / 0.6) * 100) / 100;
  }

  for (const n of (store.nicotineEntries || [])) {
    if (!n?.date) continue;
    const e = entryFor(n.date);
    if (!e.nicotine) e.nicotine = { items: [], totalMg: 0 };
    const mgPerUnit = Number(n.mgPerUnit) || 0, count = Number(n.count) || 1;
    e.nicotine.items.push({ product: n.product || '', mgPerUnit, count });
    e.nicotine.totalMg = Math.round((e.nicotine.totalMg + mgPerUnit * count) * 100) / 100;
  }

  const entries = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  return { entries, lastEntryDate: entries.at(-1)?.date || null };
}

export async function readDailyLogIfEnabled() {
  if (!(await isMortalLoomEnabled())) return null;
  const store = await readStore();
  return store ? buildDailyLogFromMortalLoom(store) : null;
}

// === Status / import (used by Settings UI) ===

export async function getStatus() {
  const s = await getSettings();
  const path = s?.mortalloom?.path?.trim() || DEFAULT_ICLOUD_PATH;
  const enabled = Boolean(s?.mortalloom?.enabled);
  const exists = existsSync(path);
  if (!exists) {
    return { enabled, path, usingDefault: path === DEFAULT_ICLOUD_PATH, defaultPath: DEFAULT_ICLOUD_PATH,
             exists: false, size: 0, mtime: null, summary: null, appStoreUrl: MORTALLOOM_APP_STORE_URL };
  }
  const st = await stat(path);
  const data = safeJSONParse(await readFile(path, 'utf-8'), null);
  const count = k => Array.isArray(data?.[k]) ? data[k].length : 0;
  return {
    enabled, path, usingDefault: path === DEFAULT_ICLOUD_PATH, defaultPath: DEFAULT_ICLOUD_PATH,
    exists: true, size: st.size, mtime: st.mtime.toISOString(),
    summary: data && typeof data === 'object' ? {
      goals: count('goals'),
      alcoholDrinks: count('alcoholDrinks'),
      nicotineEntries: count('nicotineEntries'),
      bloodTests: count('bloodTests'),
      bodyEntries: count('bodyEntries'),
      epigeneticTests: count('epigeneticTests'),
      eyeExams: count('eyeExams'),
      saunaSessions: count('saunaSessions'),
      hasProfile: Boolean(data.profile),
      hasGenome: Boolean(data.genomeScanRecord)
    } : null,
    appStoreUrl: MORTALLOOM_APP_STORE_URL
  };
}

/** Non-destructive import: append MortalLoom records missing from PortOS local files. */
export async function importToPortOS() {
  const store = await readStore();
  if (!store) return { ok: false, reason: 'mortalloom-file-not-found' };

  const report = { added: {}, skipped: {} };
  const mergeById = async (mlArr, localPath, pathDir) => {
    const local = await readJSONFile(localPath, []);
    const localArr = Array.isArray(local) ? local : [];
    const seen = new Set(localArr.map(x => x.id).filter(Boolean));
    let added = 0, skipped = 0;
    for (const item of mlArr) {
      if (item?.id && seen.has(item.id)) { skipped++; continue; }
      localArr.push(item); added++;
    }
    if (added > 0) {
      await ensureDir(pathDir);
      await writeFile(localPath, JSON.stringify(localArr, null, 2));
    }
    return { added, skipped };
  };

  // Goals live in a wrapper object, not a bare array
  const goalsPath = dataPath('digital-twin', 'goals.json');
  const localGoals = await readJSONFile(goalsPath, { goals: [] });
  const seenGoalIds = new Set((localGoals.goals || []).map(g => g.id));
  let gAdded = 0, gSkipped = 0;
  for (const g of (store.goals || [])) {
    if (seenGoalIds.has(g.id)) { gSkipped++; continue; }
    localGoals.goals.push(g); gAdded++;
  }
  if (gAdded > 0) {
    await ensureDir(dataPath('digital-twin'));
    localGoals.updatedAt = new Date().toISOString();
    await writeFile(goalsPath, JSON.stringify(localGoals, null, 2));
  }
  report.added.goals = gAdded; report.skipped.goals = gSkipped;

  for (const [mlKey, fileName] of [
    ['alcoholDrinks', 'alcohol-drinks.json'],
    ['nicotineEntries', 'nicotine-entries.json'],
    ['bloodTests', 'blood-tests.json'],
    ['bodyEntries', 'body-entries.json'],
    ['epigeneticTests', 'epigenetic-tests.json'],
    ['eyeExams', 'eyes.json'],
    ['saunaSessions', 'sauna-sessions.json'],
    ['habits', 'habits.json'],
    ['healthMetrics', 'health-metrics.json']
  ]) {
    const mlArr = store[mlKey] || [];
    if (mlArr.length === 0) { report.added[mlKey] = 0; report.skipped[mlKey] = 0; continue; }
    const { added, skipped } = await mergeById(mlArr, dataPath('meatspace', fileName), dataPath('meatspace'));
    report.added[mlKey] = added; report.skipped[mlKey] = skipped;
  }

  if (store.profile && typeof store.profile === 'object') {
    const profilePath = dataPath('meatspace', 'profile.json');
    if (!existsSync(profilePath)) {
      await ensureDir(dataPath('meatspace'));
      await writeFile(profilePath, JSON.stringify(store.profile, null, 2));
      report.added.profile = 1; report.skipped.profile = 0;
    } else {
      report.added.profile = 0; report.skipped.profile = 1;
    }
  }

  report.ok = true;
  report.importedAt = new Date().toISOString();
  return report;
}
