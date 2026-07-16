// Daily Driver state (issue #2666).
//
// Tracks two timezone-correct, per-day signals that gate the Daily Driver
// dashboard card:
//   - firstVisitToday — the user's FIRST landing of the current local day
//     (used to decide whether to surface / auto-expand the driver).
//   - handledToday    — the user has completed or dismissed the driver for the
//     current local day (the card self-hides once this is set).
//
// State is a tiny per-install file; there are ZERO LLM calls here — this module
// only reads/writes flags, honoring the AI Provider Usage Policy (nothing fires
// on first visit or boot).

import { join } from 'path';
import { atomicWrite, ensureDir, PATHS, readJSONFile } from '../lib/fileUtils.js';
import { getUserTimezone, todayInTimezone } from '../lib/timezone.js';

const FILE = join(PATHS.data, 'daily-driver.json');

/**
 * Pure: derive the driver state for `today` (YYYY-MM-DD) from a stored record.
 * `firstVisitToday` is true when the last recorded visit was NOT today (a fresh
 * day or a never-visited install); `handledToday` is true when the driver was
 * marked handled today. Sentinel discipline: absent markers (null) mean
 * "never" — a never-visited install correctly reports firstVisitToday=true.
 */
export function computeDriverState(record, today) {
  const lastVisitDay = record?.lastVisitDay || null;
  const handledDay = record?.handledDay || null;
  return {
    today,
    firstVisitToday: lastVisitDay !== today,
    handledToday: handledDay === today,
  };
}

async function load() {
  return (await readJSONFile(FILE, null)) || {};
}

async function save(record) {
  await ensureDir(PATHS.data);
  await atomicWrite(FILE, record);
}

async function localToday() {
  const tz = await getUserTimezone();
  return todayInTimezone(tz);
}

/**
 * Read the driver state and record this visit. The returned state reflects the
 * record as it was BEFORE this visit (so `firstVisitToday` is true exactly once
 * per local day, on the first landing), then stamps `lastVisitDay = today`.
 */
export async function getAndRecordVisit() {
  const today = await localToday();
  const record = await load();
  const state = computeDriverState(record, today);
  if (record.lastVisitDay !== today) {
    record.lastVisitDay = today;
    await save(record);
  }
  return state;
}

/**
 * Read the driver state WITHOUT recording a visit (idempotent peek — used by
 * re-fetches after the first landing so the card can stay visible until handled).
 */
export async function getDriverState() {
  const today = await localToday();
  return computeDriverState(await load(), today);
}

/**
 * Mark the driver handled for today (user completed or dismissed the card).
 * Also stamps `lastVisitDay` so a same-day reload doesn't re-flag a first visit.
 */
export async function markDriverHandled() {
  const today = await localToday();
  const record = await load();
  record.handledDay = today;
  record.lastVisitDay = today;
  await save(record);
  return computeDriverState(record, today);
}
