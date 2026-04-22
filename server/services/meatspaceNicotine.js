/**
 * MeatSpace Nicotine Service
 *
 * Nicotine consumption logging, daily totals, and rolling averages.
 * Stores data in the shared daily-log.json under the `nicotine` key per entry.
 */

import { writeFile } from 'fs/promises';
import { join } from 'path';
import { PATHS, ensureDir, readJSONFile, getDateString } from '../lib/fileUtils.js';
import {
  isMortalLoomEnabled,
  readDailyLogIfEnabled,
  mlPush,
  mlPatchById,
  mlRemoveById,
  mlIdAtDateIndex
} from './mortalLoomStore.js';

const MEATSPACE_DIR = PATHS.meatspace;
const DAILY_LOG_FILE = join(MEATSPACE_DIR, 'daily-log.json');
const CUSTOM_PRODUCTS_FILE = join(MEATSPACE_DIR, 'custom-nicotine-products.json');

const DEFAULT_PRODUCTS = [
  { name: 'Stokes Pick (5mg)', mgPerUnit: 5 },
];

// Cache for rolling averages (invalidated on writes)
let averageCache = null;
let averageCacheAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

// === Pure Functions ===

/**
 * Compute rolling averages from daily entries for nicotine consumption.
 */
export function computeRollingAverages(entries) {
  const now = new Date();
  const today = getDateString(now);

  const allEntries = [...entries].sort((a, b) => a.date.localeCompare(b.date));

  // Today's total
  const todayEntry = allEntries.find(e => e.date === today);
  const todayMg = todayEntry?.nicotine?.totalMg ?? 0;
  const todayCount = todayEntry?.nicotine?.items?.length ?? 0;

  // Helper: average over last N days
  const rollingAverage = (days) => {
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = getDateString(cutoff);

    let totalMg = 0;
    for (const entry of allEntries) {
      if (entry.date >= cutoffStr && entry.date <= today) {
        totalMg += entry.nicotine?.totalMg ?? 0;
      }
    }
    return Math.round((totalMg / days) * 100) / 100;
  };

  // All-time average
  let allTimeAvg = 0;
  if (allEntries.length > 0) {
    const firstDate = new Date(allEntries[0].date);
    const totalDays = Math.max(1, Math.ceil((now - firstDate) / (24 * 60 * 60 * 1000)));
    const totalMg = allEntries.reduce((sum, e) => sum + (e.nicotine?.totalMg || 0), 0);
    allTimeAvg = Math.round((totalMg / totalDays) * 100) / 100;
  }

  const avg7day = rollingAverage(7);
  const avg30day = rollingAverage(30);
  const weeklyTotal = Math.round(avg7day * 7 * 100) / 100;

  const nicotineDays = entries.filter(e => e.nicotine?.totalMg > 0).length;

  return {
    today: todayMg,
    todayCount,
    avg7day,
    avg30day,
    allTimeAvg,
    weeklyTotal,
    nicotineDays,
    totalEntries: allEntries.length
  };
}

/**
 * Recalculate total nicotine mg for a daily entry from its items.
 */
function recalcDayTotal(entry) {
  entry.nicotine.totalMg = Math.round(
    entry.nicotine.items.reduce((sum, d) => sum + (d.mgPerUnit ?? 0) * (d.count ?? 1), 0) * 100
  ) / 100;
}

// === File I/O ===

async function loadDailyLog() {
  const ml = await readDailyLogIfEnabled();
  if (ml) return ml;
  const raw = await readJSONFile(DAILY_LOG_FILE, { entries: [], lastEntryDate: null }, { allowArray: false });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { entries: [], lastEntryDate: null };
  if (!Array.isArray(raw.entries)) raw.entries = [];
  return raw;
}

async function saveDailyLog(log) {
  await ensureDir(MEATSPACE_DIR);
  await writeFile(DAILY_LOG_FILE, JSON.stringify(log, null, 2));
  averageCache = null;
}

// === Exported Service Functions ===

export async function getNicotineSummary() {
  const now = Date.now();
  if (averageCache && (now - averageCacheAt < CACHE_TTL_MS)) {
    return averageCache;
  }

  const log = await loadDailyLog();
  const averages = computeRollingAverages(log.entries || []);

  // Recent entries (last 7 days)
  const today = getDateString();
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const weekAgoStr = getDateString(weekAgo);

  const recentEntries = (log.entries || [])
    .filter(e => e.date >= weekAgoStr && e.date <= today && e.nicotine?.items?.length > 0)
    .sort((a, b) => b.date.localeCompare(a.date));

  averageCache = { ...averages, recentEntries };
  averageCacheAt = now;

  return averageCache;
}

export async function getDailyNicotine(from, to) {
  const log = await loadDailyLog();
  let entries = (log.entries || []).filter(e => e.nicotine?.items?.length > 0);

  if (from) entries = entries.filter(e => e.date >= from);
  if (to) entries = entries.filter(e => e.date <= to);

  return entries.sort((a, b) => b.date.localeCompare(a.date));
}

export async function logNicotine({ product, mgPerUnit, count = 1, date }) {
  const targetDate = date || getDateString();
  const totalMg = Math.round(mgPerUnit * count * 100) / 100;
  const item = { product: product || '', mgPerUnit, count };

  if (await isMortalLoomEnabled()) {
    await mlPush('nicotineEntries', { ...item, date: targetDate });
    averageCache = null;
    const log = await loadDailyLog();
    const entry = log.entries.find(e => e.date === targetDate);
    console.log(`🚬 Logged nicotine (MortalLoom): ${product || 'unnamed'} ${mgPerUnit}mg x${count} on ${targetDate}`);
    return { item, totalMg, date: targetDate, dayTotal: entry?.nicotine?.totalMg || totalMg };
  }

  const log = await loadDailyLog();
  let entry = log.entries.find(e => e.date === targetDate);
  if (!entry) { entry = { date: targetDate }; log.entries.push(entry); }
  if (!entry.nicotine) entry.nicotine = { items: [], totalMg: 0 };

  const existing = entry.nicotine.items.find(i => i.product === item.product && i.mgPerUnit === item.mgPerUnit);
  if (existing) existing.count = (existing.count || 1) + count;
  else entry.nicotine.items.push(item);
  recalcDayTotal(entry);

  log.entries.sort((a, b) => a.date.localeCompare(b.date));
  log.lastEntryDate = log.entries.at(-1).date;
  await saveDailyLog(log);
  console.log(`🚬 Logged nicotine: ${product || 'unnamed'} ${mgPerUnit}mg x${count} (${totalMg}mg) on ${targetDate}`);
  return { item, totalMg, date: targetDate, dayTotal: entry.nicotine.totalMg };
}

export async function updateNicotine(date, index, updates) {
  if (await isMortalLoomEnabled()) {
    const id = await mlIdAtDateIndex('nicotineEntries', date, index);
    if (!id) return null;
    const patch = {};
    for (const k of ['product', 'mgPerUnit', 'count', 'date']) {
      if (updates[k] !== undefined) patch[k] = updates[k];
    }
    const updated = await mlPatchById('nicotineEntries', id, patch);
    averageCache = null;
    const effectiveDate = updated?.date || date;
    const log = await loadDailyLog();
    const entry = log.entries.find(e => e.date === effectiveDate);
    console.log(`📝 Updated nicotine (MortalLoom) ${date}[${index}] → ${effectiveDate}: ${updated?.product}`);
    return { item: { product: updated.product, mgPerUnit: updated.mgPerUnit, count: updated.count },
             dayTotal: entry?.nicotine?.totalMg || 0,
             date: effectiveDate };
  }

  const log = await loadDailyLog();
  const entry = log.entries.find(e => e.date === date);
  if (!entry?.nicotine?.items?.[index]) return null;

  const item = entry.nicotine.items[index];
  if (updates.product !== undefined) item.product = updates.product;
  if (updates.mgPerUnit !== undefined) item.mgPerUnit = updates.mgPerUnit;
  if (updates.count !== undefined) item.count = updates.count;

  // Move to different date if requested
  const newDate = updates.date;
  if (newDate && newDate !== date) {
    entry.nicotine.items.splice(index, 1);
    if (entry.nicotine.items.length === 0) {
      delete entry.nicotine;
      // Remove entry entirely if no other data keys remain
      if (Object.keys(entry).length <= 1) {
        log.entries = log.entries.filter(e => e !== entry);
      }
    } else {
      recalcDayTotal(entry);
    }

    let targetEntry = log.entries.find(e => e.date === newDate);
    if (!targetEntry) {
      targetEntry = { date: newDate };
      log.entries.push(targetEntry);
    }
    if (!targetEntry.nicotine) targetEntry.nicotine = { items: [], totalMg: 0 };
    targetEntry.nicotine.items.push(item);
    recalcDayTotal(targetEntry);

    log.entries.sort((a, b) => a.date.localeCompare(b.date));
    log.lastEntryDate = log.entries[log.entries.length - 1].date;

    await saveDailyLog(log);
    console.log(`📝 Moved nicotine from ${date}[${index}] to ${newDate}: ${item.product || 'unnamed'} ${item.mgPerUnit}mg x${item.count}`);
    return { item, dayTotal: targetEntry.nicotine.totalMg, date: newDate };
  }

  recalcDayTotal(entry);

  await saveDailyLog(log);
  console.log(`📝 Updated nicotine on ${date}[${index}]: ${item.product || 'unnamed'} ${item.mgPerUnit}mg x${item.count}`);
  return { item, dayTotal: entry.nicotine.totalMg };
}

export async function removeNicotine(date, index) {
  if (await isMortalLoomEnabled()) {
    const id = await mlIdAtDateIndex('nicotineEntries', date, index);
    if (!id) return null;
    const removed = await mlRemoveById('nicotineEntries', id);
    averageCache = null;
    return removed;
  }

  const log = await loadDailyLog();
  const entry = log.entries.find(e => e.date === date);
  if (!entry?.nicotine?.items?.[index]) return null;

  const removed = entry.nicotine.items.splice(index, 1)[0];
  if (entry.nicotine.items.length === 0) delete entry.nicotine;
  else recalcDayTotal(entry);
  await saveDailyLog(log);
  return removed;
}

// === Custom Product Buttons ===

async function loadCustomProducts() {
  const data = await readJSONFile(CUSTOM_PRODUCTS_FILE, null, { allowArray: false });
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { products: DEFAULT_PRODUCTS.map(p => ({ ...p })) };
  }
  if (!Array.isArray(data.products)) data.products = [];
  return data;
}

async function saveCustomProducts(data) {
  await ensureDir(MEATSPACE_DIR);
  await writeFile(CUSTOM_PRODUCTS_FILE, JSON.stringify(data, null, 2));
}

export async function getCustomProducts() {
  const data = await loadCustomProducts();
  return data.products || [];
}

export async function addCustomProduct({ name, mgPerUnit }) {
  const data = await loadCustomProducts();
  const product = { name, mgPerUnit };
  data.products.push(product);
  await saveCustomProducts(data);
  console.log(`🚬 Added custom nicotine product: ${name} ${mgPerUnit}mg`);
  return product;
}

export async function updateCustomProduct(index, updates) {
  if (!Number.isInteger(index)) return null;
  const data = await loadCustomProducts();
  if (index < 0 || index >= data.products.length) return null;
  const product = data.products[index];
  if (updates.name !== undefined) product.name = updates.name;
  if (updates.mgPerUnit !== undefined) product.mgPerUnit = updates.mgPerUnit;
  await saveCustomProducts(data);
  console.log(`📝 Updated custom nicotine product [${index}]: ${product.name}`);
  return product;
}

export async function removeCustomProduct(index) {
  if (!Number.isInteger(index)) return null;
  const data = await loadCustomProducts();
  if (index < 0 || index >= data.products.length) return null;
  const removed = data.products.splice(index, 1)[0];
  await saveCustomProducts(data);
  console.log(`🗑️ Removed custom nicotine product: ${removed.name}`);
  return removed;
}

export async function reorderCustomProducts(fromIndex, toIndex) {
  if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) return null;
  const data = await loadCustomProducts();
  if (fromIndex < 0 || fromIndex >= data.products.length) return null;
  if (toIndex < 0 || toIndex >= data.products.length) return null;
  const [moved] = data.products.splice(fromIndex, 1);
  data.products.splice(toIndex, 0, moved);
  await saveCustomProducts(data);
  return data.products;
}
