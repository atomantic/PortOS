/**
 * MeatSpace POST - Memory Builder Service
 *
 * CRUD and practice tracking for memory items (songs, poems, speeches, sequences).
 * Built-in content: Tom Lehrer's "The Elements" song.
 */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { atomicWrite, PATHS, ensureDir, readJSONFile } from '../lib/fileUtils.js';
import { shuffle } from '../lib/arrayUtils.js';

const MEATSPACE_DIR = PATHS.meatspace;
const MEMORY_ITEMS_FILE = join(MEATSPACE_DIR, 'post-memory-items.json');
const TRAINING_LOG_FILE = join(MEATSPACE_DIR, 'post-training-log.json');

// =============================================================================
// SPACED-REPETITION SCHEDULER (SM-2 inspired)
// =============================================================================
//
// Every memory item carries a lightweight review schedule:
//   { ease, intervalDays, nextReview, lastReviewed }
// An item is "due" when `nextReview <= now`. Practicing it advances the schedule
// (a correct-heavy session pushes the next review further out; a miss resets it
// to "due now" so the item resurfaces immediately). The 4-field shape is
// additive and migration-safe — legacy items with no schedule are treated as
// due now (see `ensureSchedule`) and get a persisted default by migration 154.

export const DEFAULT_EASE = 2.5;
// =============================================================================
// WINDOWED (DECAY-AWARE) MASTERY
// =============================================================================
//
// Element/chunk mastery is judged over a rolling window of the most-recent
// attempts, NOT cumulative all-time counts — so a run of recent misses lowers
// mastery (decay-aware) instead of an early wrong answer being permanently
// diluted, and mastery reflects whether you STILL know it. The cumulative
// `correct`/`attempts` counts are kept for history; the window rides alongside
// as a bounded `recent` array of per-attempt correctness (1/0, most-recent
// last, capped at MASTERY_WINDOW). Legacy items with no `recent` array fall back
// to the cumulative counts so old data still reports sensibly (issue #2096).
export const MASTERY_WINDOW = 10;
// Mastery gate: at least this many attempts (in the window) at ≥ this accuracy.
export const MASTERY_MIN_ATTEMPTS = 3;
export const MASTERY_TARGET_ACCURACY = 0.8;

/** Push a per-attempt correctness flag onto a mastery stat's rolling window. */
function pushRecent(stat, correct) {
  if (!Array.isArray(stat.recent)) stat.recent = [];
  stat.recent.push(correct ? 1 : 0);
  if (stat.recent.length > MASTERY_WINDOW) {
    stat.recent = stat.recent.slice(-MASTERY_WINDOW);
  }
}

/**
 * Recency-weighted accuracy for a mastery stat: uses the bounded `recent`
 * window when present (decay-aware — recent misses lower it), else falls back to
 * the cumulative all-time `correct`/`attempts` for legacy items with no window.
 * Returns `{ attempts, accuracy }` where `attempts` is the count the mastery
 * gate is judged against.
 */
export function windowedAccuracy(stat) {
  if (Array.isArray(stat?.recent) && stat.recent.length) {
    const attempts = stat.recent.length;
    const correct = stat.recent.reduce((sum, r) => sum + (r ? 1 : 0), 0);
    return { attempts, accuracy: attempts ? correct / attempts : 0 };
  }
  const attempts = Number.isFinite(stat?.attempts) ? stat.attempts : 0;
  const correct = Number.isFinite(stat?.correct) ? stat.correct : 0;
  return { attempts, accuracy: attempts ? correct / attempts : 0 };
}

/** True when a mastery stat clears the windowed gate (≥3 recent attempts, ≥0.8). */
export function isStatMastered(stat) {
  const { attempts, accuracy } = windowedAccuracy(stat);
  return attempts >= MASTERY_MIN_ATTEMPTS && accuracy >= MASTERY_TARGET_ACCURACY;
}

const MIN_EASE = 1.3;
// Ceiling mirrors `memoryScheduleSchema.ease.max(5)` in postValidation.js — the
// per-session +0.1 bumps are unbounded otherwise, so ~26 perfect reps would push
// ease past 5 and a later round-trip through POST/PUT (import / out-of-band
// reschedule) would 400 on the server's own value. Keep the two in sync.
const MAX_EASE = 5;
// Cap the interval at a year so a long run of perfect reviews can't grow it
// without bound — an astronomically large `intervalDays` would overflow
// `new Date(now + intervalDays*DAY_MS)` into an Invalid Date and throw. A yearly
// review floor is a conventional SRS ceiling and keeps items resurfacing.
const MAX_INTERVAL_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Fresh schedule — due at `nowIso` (i.e. immediately). */
export function defaultSchedule(nowIso = new Date().toISOString()) {
  return { ease: DEFAULT_EASE, intervalDays: 0, nextReview: nowIso, lastReviewed: null };
}

/**
 * Guarantee an item has a valid schedule. Legacy/built-in items with none get a
 * default anchored to their own `updatedAt`/`createdAt` (stable + in the past →
 * due now), so "due" state doesn't flap between reads. Mutates in place.
 */
function ensureSchedule(item) {
  const s = item?.schedule;
  const valid = s && typeof s === 'object' && typeof s.nextReview === 'string';
  if (!valid) {
    item.schedule = defaultSchedule(item?.updatedAt || item?.createdAt || new Date().toISOString());
  }
  return item;
}

/**
 * Advance a schedule from a practice session's correctness ratio (0..1).
 * Pure — returns a new schedule object, never mutates the input.
 *   - ratio maps to an SM-2 quality (0..5); ease adjusts per the SM-2 formula.
 *   - quality < 3 (a miss-heavy session) → intervalDays 0 → due now again.
 *   - otherwise the interval steps 0→1→6→round(interval*ease).
 */
export function advanceSchedule(schedule, ratio, now = new Date()) {
  const prev = schedule && typeof schedule === 'object' ? schedule : {};
  const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  const quality = Math.round(clamped * 5); // 0..5
  const nowIso = now.toISOString();

  const prevEase = typeof prev.ease === 'number' ? prev.ease : DEFAULT_EASE;
  let ease = prevEase + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  ease = Math.min(MAX_EASE, Math.max(MIN_EASE, Math.round(ease * 100) / 100));

  let intervalDays;
  if (quality < 3) {
    intervalDays = 0; // relearn — resurface immediately
  } else {
    const prevInterval = typeof prev.intervalDays === 'number' ? prev.intervalDays : 0;
    if (prevInterval <= 0) intervalDays = 1;
    else if (prevInterval < 6) intervalDays = 6;
    else intervalDays = Math.max(1, Math.round(prevInterval * ease));
    intervalDays = Math.min(MAX_INTERVAL_DAYS, intervalDays);
  }

  const nextReview = new Date(now.getTime() + intervalDays * DAY_MS).toISOString();
  return { ease, intervalDays, nextReview, lastReviewed: nowIso };
}

/**
 * Merge a freshly-advanced schedule against the item's prior schedule, gating
 * interval GROWTH to once per review day.
 *
 * Why: a "review" of a memory item is one pass through it, but the existing
 * spaced-practice flow (`MemoryPractice.advanceSpaced`) submits once PER CHUNK.
 * Advancing on every submission would compound a multi-chunk item's interval in
 * a single sitting (0→1→6→16d) and drop it off the due list far longer than one
 * completed review warrants. So a same-day continuation only refreshes ease and
 * `lastReviewed` — it keeps the interval/nextReview already set earlier today.
 * A miss (interval shrinks to 0) always applies, so a fumbled chunk still
 * resurfaces the item immediately regardless of earlier same-day success.
 */
export function mergeScheduleAdvance(prev, advanced, now = new Date()) {
  const prevInterval = typeof prev?.intervalDays === 'number' ? prev.intervalDays : 0;
  const lastReviewedMs = Date.parse(prev?.lastReviewed ?? '');
  const sameReviewDay = Number.isFinite(lastReviewedMs)
    && new Date(lastReviewedMs).toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
  // Suppress compounding only when this is a same-day continuation AND the
  // interval would grow. Any shrink (a miss reset) always applies.
  if (sameReviewDay && advanced.intervalDays > prevInterval) {
    return { ...prev, ease: advanced.ease, lastReviewed: advanced.lastReviewed };
  }
  return advanced;
}

/** True when an item is due for review (no schedule / invalid date = due). */
export function isMemoryItemDue(item, now = new Date()) {
  const nr = item?.schedule?.nextReview;
  if (typeof nr !== 'string') return true;
  const t = Date.parse(nr);
  return Number.isNaN(t) || t <= now.getTime();
}

// =============================================================================
// TOM LEHRER'S ELEMENTS SONG — BUILT-IN CONTENT
// =============================================================================

const ELEMENTS_SONG = {
  id: 'elements-song',
  title: "The Elements (Tom Lehrer)",
  type: 'song',
  builtin: true,
  content: {
    lines: [
      { text: "There's antimony, arsenic, aluminum, selenium,", elements: ["Sb", "As", "Al", "Se"] },
      { text: "And hydrogen and oxygen and nitrogen and rhenium,", elements: ["H", "O", "N", "Re"] },
      { text: "And nickel, neodymium, neptunium, germanium,", elements: ["Ni", "Nd", "Np", "Ge"] },
      { text: "And iron, americium, ruthenium, uranium,", elements: ["Fe", "Am", "Ru", "U"] },
      { text: "Europium, zirconium, lutetium, vanadium,", elements: ["Eu", "Zr", "Lu", "V"] },
      { text: "And lanthanum and osmium and astatine and radium,", elements: ["La", "Os", "At", "Ra"] },
      { text: "And gold and protactinium and indium and gallium,", elements: ["Au", "Pa", "In", "Ga"] },
      { text: "And iodine and thorium and thulium and thallium.", elements: ["I", "Th", "Tm", "Tl"] },
      { text: "There's yttrium, ytterbium, actinium, rubidium,", elements: ["Y", "Yb", "Ac", "Rb"] },
      { text: "And boron, gadolinium, niobium, iridium,", elements: ["B", "Gd", "Nb", "Ir"] },
      { text: "And strontium and silicon and silver and samarium,", elements: ["Sr", "Si", "Ag", "Sm"] },
      { text: "And bismuth, bromine, lithium, beryllium, and barium.", elements: ["Bi", "Br", "Li", "Be", "Ba"] },
      { text: "There's holmium and helium and hafnium and erbium,", elements: ["Ho", "He", "Hf", "Er"] },
      { text: "And phosphorus and francium and fluorine and terbium,", elements: ["P", "Fr", "F", "Tb"] },
      { text: "And manganese and mercury, molybdenum, magnesium,", elements: ["Mn", "Hg", "Mo", "Mg"] },
      { text: "Dysprosium and scandium and cerium and cesium.", elements: ["Dy", "Sc", "Ce", "Cs"] },
      { text: "And lead, praseodymium, and platinum, plutonium,", elements: ["Pb", "Pr", "Pt", "Pu"] },
      { text: "Palladium, promethium, potassium, polonium,", elements: ["Pd", "Pm", "K", "Po"] },
      { text: "And tantalum, technetium, titanium, tellurium,", elements: ["Ta", "Tc", "Ti", "Te"] },
      { text: "And cadmium and calcium and chromium and curium.", elements: ["Cd", "Ca", "Cr", "Cm"] },
      { text: "There's sulfur, californium, and fermium, berkelium,", elements: ["S", "Cf", "Fm", "Bk"] },
      { text: "And also mendelevium, einsteinium, nobelium,", elements: ["Md", "Es", "No"] },
      { text: "And argon, krypton, neon, radon, xenon, zinc, and rhodium,", elements: ["Ar", "Kr", "Ne", "Rn", "Xe", "Zn", "Rh"] },
      { text: "And chlorine, carbon, cobalt, copper, tungsten, tin, and sodium.", elements: ["Cl", "C", "Co", "Cu", "W", "Sn", "Na"] },
      { text: "These are the only ones of which the news has come to Harvard,", elements: [] },
      { text: "And there may be many others, but they haven't been discovered.", elements: [] },
      // Appendix: Elements discovered since Tom Lehrer's song (103-118)
      { text: "There's lawrencium, rutherfordium, dubnium, seaborgium,", elements: ["Lr", "Rf", "Db", "Sg"] },
      { text: "And bohrium and hassium and also meitnerium,", elements: ["Bh", "Hs", "Mt"] },
      { text: "Darmstadtium, roentgenium, copernicium,", elements: ["Ds", "Rg", "Cn"] },
      { text: "Nihonium, flerovium, moscovium, livermorium,", elements: ["Nh", "Fl", "Mc", "Lv"] },
      { text: "And tennessine and oganesson complete the set—", elements: ["Ts", "Og"] },
      { text: "These are the ones that Lehrer hadn't discovered yet.", elements: [] },
    ],
    chunks: [
      { id: "verse-1", lineRange: [0, 7], label: "Verse 1" },
      { id: "verse-2", lineRange: [8, 11], label: "Verse 2" },
      { id: "verse-3", lineRange: [12, 15], label: "Verse 3" },
      { id: "verse-4", lineRange: [16, 19], label: "Verse 4" },
      { id: "verse-5", lineRange: [20, 23], label: "Verse 5" },
      { id: "coda", lineRange: [24, 25], label: "Coda" },
      { id: "appendix", lineRange: [26, 31], label: "Appendix (Post-Lehrer)" },
    ],
    // Element symbol → { name, atomicNumber } for the periodic table visualization
    elementMap: {
      H: { name: "Hydrogen", atomicNumber: 1 }, He: { name: "Helium", atomicNumber: 2 },
      Li: { name: "Lithium", atomicNumber: 3 }, Be: { name: "Beryllium", atomicNumber: 4 },
      B: { name: "Boron", atomicNumber: 5 }, C: { name: "Carbon", atomicNumber: 6 },
      N: { name: "Nitrogen", atomicNumber: 7 }, O: { name: "Oxygen", atomicNumber: 8 },
      F: { name: "Fluorine", atomicNumber: 9 }, Ne: { name: "Neon", atomicNumber: 10 },
      Na: { name: "Sodium", atomicNumber: 11 }, Mg: { name: "Magnesium", atomicNumber: 12 },
      Al: { name: "Aluminum", atomicNumber: 13 }, Si: { name: "Silicon", atomicNumber: 14 },
      P: { name: "Phosphorus", atomicNumber: 15 }, S: { name: "Sulfur", atomicNumber: 16 },
      Cl: { name: "Chlorine", atomicNumber: 17 }, Ar: { name: "Argon", atomicNumber: 18 },
      K: { name: "Potassium", atomicNumber: 19 }, Ca: { name: "Calcium", atomicNumber: 20 },
      Sc: { name: "Scandium", atomicNumber: 21 }, Ti: { name: "Titanium", atomicNumber: 22 },
      V: { name: "Vanadium", atomicNumber: 23 }, Cr: { name: "Chromium", atomicNumber: 24 },
      Mn: { name: "Manganese", atomicNumber: 25 }, Hg: { name: "Mercury", atomicNumber: 80 }, Fe: { name: "Iron", atomicNumber: 26 },
      Co: { name: "Cobalt", atomicNumber: 27 }, Ni: { name: "Nickel", atomicNumber: 28 },
      Cu: { name: "Copper", atomicNumber: 29 }, Zn: { name: "Zinc", atomicNumber: 30 },
      Ga: { name: "Gallium", atomicNumber: 31 }, Ge: { name: "Germanium", atomicNumber: 32 },
      As: { name: "Arsenic", atomicNumber: 33 }, Se: { name: "Selenium", atomicNumber: 34 },
      Br: { name: "Bromine", atomicNumber: 35 }, Kr: { name: "Krypton", atomicNumber: 36 },
      Rb: { name: "Rubidium", atomicNumber: 37 }, Sr: { name: "Strontium", atomicNumber: 38 },
      Y: { name: "Yttrium", atomicNumber: 39 }, Zr: { name: "Zirconium", atomicNumber: 40 },
      Nb: { name: "Niobium", atomicNumber: 41 }, Mo: { name: "Molybdenum", atomicNumber: 42 },
      Tc: { name: "Technetium", atomicNumber: 43 }, Ru: { name: "Ruthenium", atomicNumber: 44 },
      Rh: { name: "Rhodium", atomicNumber: 45 }, Pd: { name: "Palladium", atomicNumber: 46 },
      Ag: { name: "Silver", atomicNumber: 47 }, Cd: { name: "Cadmium", atomicNumber: 48 },
      In: { name: "Indium", atomicNumber: 49 }, Sn: { name: "Tin", atomicNumber: 50 },
      Sb: { name: "Antimony", atomicNumber: 51 }, Te: { name: "Tellurium", atomicNumber: 52 },
      I: { name: "Iodine", atomicNumber: 53 }, Xe: { name: "Xenon", atomicNumber: 54 },
      Cs: { name: "Cesium", atomicNumber: 55 }, Ba: { name: "Barium", atomicNumber: 56 },
      La: { name: "Lanthanum", atomicNumber: 57 }, Ce: { name: "Cerium", atomicNumber: 58 },
      Pr: { name: "Praseodymium", atomicNumber: 59 }, Nd: { name: "Neodymium", atomicNumber: 60 },
      Pm: { name: "Promethium", atomicNumber: 61 }, Sm: { name: "Samarium", atomicNumber: 62 },
      Eu: { name: "Europium", atomicNumber: 63 }, Gd: { name: "Gadolinium", atomicNumber: 64 },
      Tb: { name: "Terbium", atomicNumber: 65 }, Dy: { name: "Dysprosium", atomicNumber: 66 },
      Ho: { name: "Holmium", atomicNumber: 67 }, Er: { name: "Erbium", atomicNumber: 68 },
      Tm: { name: "Thulium", atomicNumber: 69 }, Yb: { name: "Ytterbium", atomicNumber: 70 },
      Lu: { name: "Lutetium", atomicNumber: 71 }, Hf: { name: "Hafnium", atomicNumber: 72 },
      Ta: { name: "Tantalum", atomicNumber: 73 }, W: { name: "Tungsten", atomicNumber: 74 },
      Re: { name: "Rhenium", atomicNumber: 75 }, Os: { name: "Osmium", atomicNumber: 76 },
      Ir: { name: "Iridium", atomicNumber: 77 }, Pt: { name: "Platinum", atomicNumber: 78 },
      Au: { name: "Gold", atomicNumber: 79 }, Tl: { name: "Thallium", atomicNumber: 81 },
      Pb: { name: "Lead", atomicNumber: 82 }, Bi: { name: "Bismuth", atomicNumber: 83 },
      Po: { name: "Polonium", atomicNumber: 84 }, At: { name: "Astatine", atomicNumber: 85 },
      Rn: { name: "Radon", atomicNumber: 86 }, Fr: { name: "Francium", atomicNumber: 87 },
      Ra: { name: "Radium", atomicNumber: 88 }, Ac: { name: "Actinium", atomicNumber: 89 },
      Th: { name: "Thorium", atomicNumber: 90 }, Pa: { name: "Protactinium", atomicNumber: 91 },
      U: { name: "Uranium", atomicNumber: 92 }, Np: { name: "Neptunium", atomicNumber: 93 },
      Pu: { name: "Plutonium", atomicNumber: 94 }, Am: { name: "Americium", atomicNumber: 95 },
      Cm: { name: "Curium", atomicNumber: 96 }, Bk: { name: "Berkelium", atomicNumber: 97 },
      Cf: { name: "Californium", atomicNumber: 98 }, Es: { name: "Einsteinium", atomicNumber: 99 },
      Fm: { name: "Fermium", atomicNumber: 100 }, Md: { name: "Mendelevium", atomicNumber: 101 },
      No: { name: "Nobelium", atomicNumber: 102 }, Lr: { name: "Lawrencium", atomicNumber: 103 },
      Rf: { name: "Rutherfordium", atomicNumber: 104 }, Db: { name: "Dubnium", atomicNumber: 105 },
      Sg: { name: "Seaborgium", atomicNumber: 106 }, Bh: { name: "Bohrium", atomicNumber: 107 },
      Hs: { name: "Hassium", atomicNumber: 108 }, Mt: { name: "Meitnerium", atomicNumber: 109 },
      Ds: { name: "Darmstadtium", atomicNumber: 110 }, Rg: { name: "Roentgenium", atomicNumber: 111 },
      Cn: { name: "Copernicium", atomicNumber: 112 }, Nh: { name: "Nihonium", atomicNumber: 113 },
      Fl: { name: "Flerovium", atomicNumber: 114 }, Mc: { name: "Moscovium", atomicNumber: 115 },
      Lv: { name: "Livermorium", atomicNumber: 116 }, Ts: { name: "Tennessine", atomicNumber: 117 },
      Og: { name: "Oganesson", atomicNumber: 118 },
    }
  },
  mastery: { overallPct: 0, chunks: {}, elements: {} },
  createdAt: '2026-03-08T00:00:00.000Z',
  updatedAt: '2026-03-08T00:00:00.000Z',
};

// =============================================================================
// DATA ACCESS
// =============================================================================

async function loadMemoryItems() {
  const data = await readJSONFile(MEMORY_ITEMS_FILE, { items: [] }, { allowArray: false });
  const items = data?.items && Array.isArray(data.items) ? data.items : [];

  // Ensure built-in Elements Song is always present and content stays current
  const existingIdx = items.findIndex(i => i.id === 'elements-song');
  if (existingIdx === -1) {
    items.unshift(structuredClone(ELEMENTS_SONG));
  } else {
    const existing = items[existingIdx];
    const fresh = structuredClone(ELEMENTS_SONG);
    fresh.mastery = existing.mastery || fresh.mastery;
    // Preserve the learned review schedule across content re-seeds (like mastery).
    if (existing.schedule) fresh.schedule = existing.schedule;
    fresh.updatedAt = existing.updatedAt;
    items[existingIdx] = fresh;
  }

  // Backfill a schedule on any item that predates spaced-repetition (built-in
  // or legacy custom items) so every item is schedulable + surfaces as due.
  for (const item of items) ensureSchedule(item);

  return items;
}

async function saveMemoryItems(items) {
  await ensureDir(MEATSPACE_DIR);
  await atomicWrite(MEMORY_ITEMS_FILE, { items });
}

async function loadTrainingLog() {
  return readJSONFile(TRAINING_LOG_FILE, { entries: [] }, { allowArray: false });
}

async function saveTrainingLog(log) {
  await ensureDir(MEATSPACE_DIR);
  await atomicWrite(TRAINING_LOG_FILE, log);
}

// =============================================================================
// MEMORY ITEMS CRUD
// =============================================================================

export async function getMemoryItems() {
  return loadMemoryItems();
}

export async function getMemoryItem(id) {
  const items = await loadMemoryItems();
  return items.find(i => i.id === id) || null;
}

export async function createMemoryItem(data) {
  const items = await loadMemoryItems();
  const now = new Date().toISOString();

  const rawLines = (data.lines || []).map(l => ({
    text: l.text || l,
    ...(l.elements ? { elements: l.elements } : {})
  }));

  // Auto-chunk uses all lines (including blanks for boundary detection)
  const chunks = data.chunks || autoChunk(rawLines);

  // Store only non-empty lines for practice
  const contentLines = rawLines.filter(l => l.text.trim().length > 0);

  // Remap chunk lineRanges to match filtered line indices
  const remappedChunks = remapChunksAfterFilter(rawLines, contentLines, chunks);

  const item = {
    id: randomUUID(),
    title: data.title,
    type: data.type || 'text',
    builtin: false,
    content: {
      lines: contentLines,
      chunks: remappedChunks,
    },
    mastery: { overallPct: 0, chunks: {}, elements: {} },
    // Honor a client-provided schedule (e.g. importing an item with progress),
    // else stamp a fresh "due now" default.
    schedule: data.schedule || defaultSchedule(now),
    createdAt: now,
    updatedAt: now,
  };

  items.push(item);
  await saveMemoryItems(items);
  console.log(`🧠 Memory item created: "${item.title}" (${contentLines.length} lines, ${remappedChunks.length} chunks)`);
  return item;
}

export async function updateMemoryItem(id, updates) {
  const items = await loadMemoryItems();
  const idx = items.findIndex(i => i.id === id);
  if (idx === -1) return null;
  if (items[idx].builtin) {
    // Only allow mastery / schedule updates on built-in items
    if (updates.mastery || updates.schedule) {
      if (updates.mastery) items[idx].mastery = updates.mastery;
      if (updates.schedule) items[idx].schedule = updates.schedule;
      items[idx].updatedAt = new Date().toISOString();
      await saveMemoryItems(items);
      return items[idx];
    }
    return items[idx];
  }

  const item = items[idx];
  if (updates.title) item.title = updates.title;
  if (updates.type) item.type = updates.type;
  if (updates.schedule) item.schedule = updates.schedule;
  if (updates.lines) {
    item.content.lines = updates.lines.map(l => ({
      text: l.text || l,
      ...(l.elements ? { elements: l.elements } : {})
    }));
  }
  if (updates.chunks) {
    item.content.chunks = updates.chunks;
  }
  item.updatedAt = new Date().toISOString();
  await saveMemoryItems(items);
  console.log(`🧠 Memory item updated: "${item.title}"`);
  return item;
}

export async function deleteMemoryItem(id) {
  const items = await loadMemoryItems();
  const idx = items.findIndex(i => i.id === id);
  if (idx === -1) return null;
  if (items[idx].builtin) return null; // Can't delete built-in items
  const removed = items.splice(idx, 1)[0];
  await saveMemoryItems(items);
  console.log(`🧠 Memory item deleted: "${removed.title}"`);
  return removed;
}

// =============================================================================
// PRACTICE & MASTERY
// =============================================================================

export async function submitPractice(id, practiceData) {
  const items = await loadMemoryItems();
  const item = items.find(i => i.id === id);
  if (!item) return null;

  const { mode, chunkId, results, totalMs } = practiceData;
  const now = new Date().toISOString();

  // Update chunk mastery
  if (chunkId) {
    if (!item.mastery.chunks[chunkId]) {
      item.mastery.chunks[chunkId] = { correct: 0, attempts: 0, lastPracticed: null };
    }
    const chunk = item.mastery.chunks[chunkId];
    chunk.attempts += results.length;
    chunk.correct += results.filter(r => r.correct).length;
    chunk.lastPracticed = now;
    // Rolling window for decay-aware mastery (issue #2096) — one flag per result.
    for (const r of results) pushRecent(chunk, r.correct);
  }

  // Update element-level mastery (for elements song)
  if (results) {
    for (const r of results) {
      if (r.element) {
        if (!item.mastery.elements[r.element]) {
          item.mastery.elements[r.element] = { correct: 0, attempts: 0 };
        }
        const el = item.mastery.elements[r.element];
        el.attempts++;
        if (r.correct) el.correct++;
        pushRecent(el, r.correct);
      }
    }
  }

  // Recompute overall mastery percentage
  item.mastery.overallPct = computeOverallMastery(item);

  // Advance the spaced-repetition schedule from this session's accuracy. The
  // schedule is per-ITEM (mastery is per-chunk); practicing any part of an item
  // counts as reviewing it, so it resurfaces on the next review day rather than
  // staying due today. `mergeScheduleAdvance` gates interval growth to once per
  // day so the per-chunk submits of a spaced session don't compound the interval,
  // while a miss anywhere still resets the item to due-now.
  const correctCount = results.filter(r => r.correct).length;
  const ratio = results.length ? correctCount / results.length : 0;
  const advanced = advanceSchedule(item.schedule, ratio, new Date(now));
  item.schedule = mergeScheduleAdvance(item.schedule, advanced, new Date(now));

  item.updatedAt = now;
  await saveMemoryItems(items);

  // Log the practice session
  const log = await loadTrainingLog();
  log.entries.push({
    id: randomUUID(),
    memoryItemId: id,
    mode,
    chunkId: chunkId || null,
    correct: results.filter(r => r.correct).length,
    total: results.length,
    totalMs: totalMs || 0,
    date: now,
  });
  await saveTrainingLog(log);

  console.log(`🧠 Practice logged: "${item.title}" mode=${mode} ${correctCount}/${results.length} → next review in ${item.schedule.intervalDays}d`);
  return { mastery: item.mastery, schedule: item.schedule, practiceId: log.entries[log.entries.length - 1].id };
}

/**
 * Advance a memory item's spaced-repetition schedule from a POST-session
 * memory drill's accuracy ratio (0..1). Mirrors the schedule half of
 * `submitPractice` — a POST-session memory drill IS a review, so it should
 * reschedule the item and clear it from "Due Today" just like MemoryBuilder's
 * dedicated practice flow. Unlike `submitPractice`, this does NOT touch
 * chunk/element mastery — POST sessions don't carry the chunk/element-level
 * result data `submitPractice` uses for that.
 *
 * Returns the updated schedule, or `null` when `memoryItemId` is absent or
 * doesn't match a known item (unsupported memory drills like
 * `memory-fill-blank` carry no memoryItemId — see POST_SUPPORTED_MEMORY_TYPES).
 */
export async function advanceScheduleFromSession(memoryItemId, ratio, now = new Date()) {
  if (!memoryItemId) return null;
  const items = await loadMemoryItems();
  const item = items.find(i => i.id === memoryItemId);
  if (!item) return null;

  applyScheduleAdvanceToItem(item, ratio, now);
  await saveMemoryItems(items);

  console.log(`🧠 POST session reviewed "${item.title}" → next review in ${item.schedule.intervalDays}d`);
  return item.schedule;
}

// In-place schedule advance shared by advanceScheduleFromSession (one load+save)
// and applySessionToMemoryItems (one load+save for the WHOLE session). Keeping a
// single core guarantees the consolidated one-pass path produces byte-identical
// schedule results to the legacy per-task path.
function applyScheduleAdvanceToItem(item, ratio, now) {
  const advanced = advanceSchedule(item.schedule, ratio, now);
  item.schedule = mergeScheduleAdvance(item.schedule, advanced, now);
  item.updatedAt = now.toISOString();
  return item.schedule;
}

// In-place mastery merge shared by mergeMasteryFromSession and
// applySessionToMemoryItems — same single-core-of-truth rationale as
// applyScheduleAdvanceToItem above.
function applyMasteryMergeToItem(item, questions, now) {
  const nowIso = now.toISOString();
  for (const q of questions) {
    if (q.chunkId) {
      if (!item.mastery.chunks[q.chunkId]) {
        item.mastery.chunks[q.chunkId] = { correct: 0, attempts: 0, lastPracticed: null };
      }
      const chunk = item.mastery.chunks[q.chunkId];
      chunk.attempts += 1;
      if (q.correct) chunk.correct += 1;
      chunk.lastPracticed = nowIso;
      pushRecent(chunk, q.correct);
    }
    if (q.element) {
      if (!item.mastery.elements[q.element]) {
        item.mastery.elements[q.element] = { correct: 0, attempts: 0 };
      }
      const el = item.mastery.elements[q.element];
      el.attempts += 1;
      if (q.correct) el.correct += 1;
      pushRecent(el, q.correct);
    }
  }

  item.mastery.overallPct = computeOverallMastery(item);
  item.updatedAt = nowIso;
  return item.mastery;
}

/**
 * Merge a POST session's per-question memory drill results into an item's
 * chunk/element mastery (`item.mastery.chunks`/`item.mastery.elements`) —
 * the mastery half of what `submitPractice` does, deferred out of #2010
 * (schedule-only) into #2016 because POST-session answers didn't carry
 * chunk/element attribution until `usePostSession.js`'s `submitAnswer` started
 * preserving `q.chunkId` / `q.element` onto each answer.
 *
 * Unlike `submitPractice` (one `chunkId` for the whole batch — a dedicated
 * chunk-practice session), a POST-session memory-sequence drill can span
 * several chunks and a memory-element-flash drill spans several elements, so
 * this buckets PER-QUESTION by whichever attribution that question carries.
 * Questions with neither `chunkId` nor `element` (e.g. an unsupported/legacy
 * shape) are counted toward correctness of nothing — they simply don't shift
 * `item.mastery`.
 *
 * Returns the updated mastery, or `null` when `memoryItemId`/`questions` are
 * absent or the id doesn't match a known item.
 */
export async function mergeMasteryFromSession(memoryItemId, questions, now = new Date()) {
  if (!memoryItemId || !Array.isArray(questions) || !questions.length) return null;
  const items = await loadMemoryItems();
  const item = items.find(i => i.id === memoryItemId);
  if (!item) return null;

  applyMasteryMergeToItem(item, questions, now);
  await saveMemoryItems(items);

  console.log(`🧠 POST session mastery merged: "${item.title}" ${questions.length} answers → ${item.mastery.overallPct}% overall`);
  return item.mastery;
}

/**
 * Consolidated post-session memory bookkeeping: advance schedule AND merge
 * chunk/element mastery for every memory drill in a session, reading and writing
 * the shared memory-items file exactly ONCE regardless of task count (the
 * previous path did 2 full read-modify-write round-trips PER memory task). A
 * task is a memory drill iff it carries a `memoryItemId` — the only tasks the
 * submit path attaches one to (POST_SUPPORTED_MEMORY_TYPES). Per task the
 * schedule ratio is correct-over-total, matching the legacy per-task caller.
 *
 * @param {Array<{memoryItemId?, questions?}>} tasks - the session's scored tasks
 * @returns {Promise<{updated:number}>} how many memory items were touched
 */
export async function applySessionToMemoryItems(tasks, now = new Date()) {
  const memoryTasks = (Array.isArray(tasks) ? tasks : []).filter(t => t?.memoryItemId);
  if (!memoryTasks.length) return { updated: 0 };

  const items = await loadMemoryItems();
  let updated = 0;
  for (const task of memoryTasks) {
    const item = items.find(i => i.id === task.memoryItemId);
    if (!item) continue;
    const questions = Array.isArray(task.questions) ? task.questions : [];
    const total = questions.length;
    const correct = questions.filter(q => q?.correct).length;
    const ratio = total ? correct / total : 0;
    applyScheduleAdvanceToItem(item, ratio, now);
    // mergeMasteryFromSession is a no-op on empty questions; mirror that so the
    // one-pass path stays identical to the legacy schedule+mastery sequence.
    if (questions.length) applyMasteryMergeToItem(item, questions, now);
    updated += 1;
    console.log(`🧠 POST session reviewed "${item.title}" → next review in ${item.schedule.intervalDays}d`);
  }

  if (updated) await saveMemoryItems(items);
  return { updated };
}

/**
 * List memory items currently due for review (`nextReview <= now`), sorted by
 * how overdue they are (most overdue first).
 */
export async function getDueMemoryItems(now = new Date()) {
  const items = await loadMemoryItems();
  return items
    .filter(i => isMemoryItemDue(i, now))
    .sort((a, b) => Date.parse(a.schedule?.nextReview || 0) - Date.parse(b.schedule?.nextReview || 0));
}

export async function getMastery(id) {
  const item = await getMemoryItem(id);
  if (!item) return null;
  return item.mastery;
}

export async function getTrainingLog(memoryItemId, limit = 50) {
  const log = await loadTrainingLog();
  let entries = log.entries || [];
  if (memoryItemId) entries = entries.filter(e => e.memoryItemId === memoryItemId);
  return entries.slice(-limit);
}

// =============================================================================
// DRILL GENERATION (for POST sessions)
// =============================================================================

/**
 * Generate a memory drill for a POST session.
 * Picks the memory item with the lowest mastery (or user-configured item)
 * and creates a fill-in-the-blank or sequence recall exercise.
 * Uses spaced repetition: focuses on lowest-mastery chunks.
 */
export async function generateMemoryDrill(config = {}) {
  const items = await loadMemoryItems();
  if (!items.length) return null;

  // Pick target item — configured or lowest mastery
  let item;
  if (config.memoryItemId) {
    item = items.find(i => i.id === config.memoryItemId);
  }
  if (!item) {
    item = items.reduce((lowest, i) => i.mastery.overallPct < lowest.mastery.overallPct ? i : lowest, items[0]);
  }

  const mode = config.mode || 'fill-blank';
  const count = config.count || 5;

  switch (mode) {
    case 'fill-blank':
      return generateFillBlank(item, count);
    case 'sequence':
      return generateSequenceRecall(item, count);
    case 'element-flash':
      return generateElementFlash(item, count);
    default:
      return generateFillBlank(item, count);
  }
}

/**
 * Get chunk mastery stats for spaced repetition.
 * Returns chunks sorted by mastery (lowest first) with hint level.
 */
export function getChunkMasteryOrder(item) {
  const chunks = item.content?.chunks || [];
  return chunks.map(chunk => {
    const stats = item.mastery?.chunks?.[chunk.id];
    const accuracy = stats?.attempts > 0 ? stats.correct / stats.attempts : 0;
    // Hint level: 0 = full hints, 1 = partial, 2 = minimal, 3 = no hints
    const hintLevel = accuracy >= 0.9 ? 3 : accuracy >= 0.7 ? 2 : accuracy >= 0.4 ? 1 : 0;
    return {
      ...chunk,
      accuracy: Math.round(accuracy * 100),
      attempts: stats?.attempts || 0,
      lastPracticed: stats?.lastPracticed || null,
      hintLevel,
    };
  }).sort((a, b) => a.accuracy - b.accuracy);
}

function generateFillBlank(item, count) {
  const lines = item.content.lines.filter(l => l.text.trim().length > 0);
  if (!lines.length) return null;

  const questions = [];
  const shuffled = shuffle(lines).slice(0, Math.min(count, lines.length));

  for (const line of shuffled) {
    const words = line.text.split(/\s+/);
    if (words.length < 3) continue;

    // Blank out ~30-50% of words, preferring element names if present
    const blankedIndices = new Set();
    const blankCount = Math.max(1, Math.floor(words.length * (0.3 + Math.random() * 0.2)));

    // Prioritize element names for blanking
    if (line.elements?.length) {
      for (const sym of line.elements) {
        const elementName = item.content.elementMap?.[sym]?.name?.toLowerCase();
        if (elementName) {
          const idx = words.findIndex((w, i) => !blankedIndices.has(i) && w.toLowerCase().replace(/[,.]$/, '') === elementName);
          if (idx >= 0 && blankedIndices.size < blankCount) blankedIndices.add(idx);
        }
      }
    }

    // Fill remaining blanks randomly
    while (blankedIndices.size < blankCount) {
      blankedIndices.add(Math.floor(Math.random() * words.length));
    }

    const display = words.map((w, i) => blankedIndices.has(i) ? '____' : w).join(' ');
    const answers = [...blankedIndices].sort((a, b) => a - b).map(i => ({
      index: i,
      word: words[i].replace(/[,.]$/, ''),
      element: line.elements?.length ? findElementForWord(words[i], item.content.elementMap) : null,
    }));

    questions.push({
      prompt: display,
      fullText: line.text,
      // Scalar primary answer (the first blanked word) — kept alongside the
      // full `answers[]` acceptable-word list so consumers that expect a
      // single `expected` field (DrillQuestionReview, scoring) have a
      // consistent value instead of always reading "—"/undefined (issue
      // #2116). Scoring still checks `answers[]` for a match against ANY
      // blanked word, not just this primary one.
      expected: answers[0]?.word ?? null,
      answers,
      chunkId: findChunkForLine(item, lines.indexOf(line)),
    });
  }

  return {
    type: 'memory-fill-blank',
    memoryItemId: item.id,
    memoryItemTitle: item.title,
    config: { count },
    questions,
  };
}

function generateSequenceRecall(item, count) {
  const lines = item.content.lines.filter(l => l.text.trim().length > 0);
  if (lines.length < 2) return null;

  const questions = [];
  const indices = shuffle([...Array(lines.length - 1).keys()]).slice(0, Math.min(count, lines.length - 1));

  for (const idx of indices) {
    questions.push({
      prompt: lines[idx].text,
      promptLabel: 'What comes next?',
      expected: lines[idx + 1].text,
      chunkId: findChunkForLine(item, idx),
    });
  }

  return {
    type: 'memory-sequence',
    memoryItemId: item.id,
    memoryItemTitle: item.title,
    config: { count },
    questions,
  };
}

function generateElementFlash(item, count) {
  if (item.id !== 'elements-song' || !item.content.elementMap) return null;

  const elements = Object.entries(item.content.elementMap);
  const shuffled = shuffle(elements).slice(0, Math.min(count, elements.length));

  const questions = shuffled.map(([symbol, info]) => {
    // Randomly ask name→symbol or symbol→name
    const askSymbol = Math.random() > 0.5;
    return askSymbol
      ? { prompt: info.name, promptLabel: 'Symbol?', expected: symbol, element: symbol, direction: 'name-to-symbol' }
      : { prompt: `${symbol} (${info.atomicNumber})`, promptLabel: 'Element name?', expected: info.name, element: symbol, direction: 'symbol-to-name' };
  });

  return {
    type: 'memory-element-flash',
    memoryItemId: item.id,
    memoryItemTitle: item.title,
    config: { count },
    questions,
  };
}

// =============================================================================
// HELPERS
// =============================================================================

export function computeOverallMastery(item) {
  // For elements song: mastery is per-element, judged over the recency window
  // (decay-aware, issue #2096) — a recent run of misses lowers the count. The
  // ≥3-attempt gate is kept, but applied to the window (or the cumulative
  // fallback for legacy items with no window).
  if (item.id === 'elements-song' && item.content.elementMap) {
    const totalElements = Object.keys(item.content.elementMap).length;
    if (totalElements === 0) return 0;
    let masteredCount = 0;
    for (const sym of Object.keys(item.content.elementMap)) {
      const m = item.mastery.elements[sym];
      if (m && isStatMastered(m)) masteredCount++;
    }
    return Math.round((masteredCount / totalElements) * 100);
  }

  // For generic items: mastery is based on windowed chunk accuracy.
  const chunks = Object.values(item.mastery.chunks);
  if (!chunks.length) return 0;
  const avgAccuracy = chunks.reduce((sum, c) => sum + windowedAccuracy(c).accuracy, 0) / chunks.length;
  return Math.round(avgAccuracy * 100);
}

function findChunkForLine(item, lineIndex) {
  for (const chunk of item.content.chunks || []) {
    const [start, end] = chunk.lineRange;
    if (lineIndex >= start && lineIndex <= end) return chunk.id;
  }
  return null;
}

function findElementForWord(word, elementMap) {
  if (!elementMap) return null;
  const clean = word.toLowerCase().replace(/[,.\s]/g, '');
  for (const [symbol, info] of Object.entries(elementMap)) {
    if (info.name.toLowerCase() === clean) return symbol;
  }
  return null;
}

/**
 * Auto-chunk content into learnable segments.
 * Splits on blank lines first (verse/stanza boundaries).
 * Falls back to groups of ~4 lines if no blank lines.
 */
function autoChunk(lines) {
  const texts = lines.map(l => (typeof l === 'string' ? l : l.text) || '');

  // Check for blank-line boundaries
  const groups = [];
  let current = [];
  let startIdx = 0;
  for (let i = 0; i < texts.length; i++) {
    if (texts[i].trim() === '' && current.length > 0) {
      groups.push({ start: startIdx, end: i - 1 });
      current = [];
      startIdx = i + 1;
    } else if (texts[i].trim() !== '') {
      current.push(i);
    }
  }
  if (current.length > 0) {
    groups.push({ start: startIdx, end: texts.length - 1 });
  }

  // If blank-line splitting produced reasonable chunks (2+), use them
  if (groups.length >= 2) {
    return groups.map((g, i) => ({
      id: `chunk-${i + 1}`,
      lineRange: [g.start, g.end],
      label: `Part ${i + 1}`,
    }));
  }

  // Fallback: fixed-size groups of ~4 lines
  const chunkSize = 4;
  const chunks = [];
  for (let i = 0; i < lines.length; i += chunkSize) {
    const end = Math.min(i + chunkSize - 1, lines.length - 1);
    chunks.push({
      id: `chunk-${Math.floor(i / chunkSize) + 1}`,
      lineRange: [i, end],
      label: `Part ${Math.floor(i / chunkSize) + 1}`,
    });
  }
  return chunks;
}

/**
 * Remap chunk lineRanges after blank lines are filtered out.
 * Maps original indices to new indices in the filtered array.
 */
function remapChunksAfterFilter(rawLines, filteredLines, chunks) {
  // Build mapping: original index → filtered index
  const indexMap = new Map();
  let filteredIdx = 0;
  for (let i = 0; i < rawLines.length; i++) {
    const text = typeof rawLines[i] === 'string' ? rawLines[i] : rawLines[i].text;
    if (text.trim().length > 0) {
      indexMap.set(i, filteredIdx);
      filteredIdx++;
    }
  }

  return chunks.map(chunk => {
    const [origStart, origEnd] = chunk.lineRange;
    // Find first and last non-empty lines in this chunk's range
    let newStart = null;
    let newEnd = null;
    for (let i = origStart; i <= origEnd; i++) {
      if (indexMap.has(i)) {
        if (newStart === null) newStart = indexMap.get(i);
        newEnd = indexMap.get(i);
      }
    }
    if (newStart === null) return null; // Empty chunk
    return { ...chunk, lineRange: [newStart, newEnd] };
  }).filter(Boolean);
}

export { ELEMENTS_SONG };
