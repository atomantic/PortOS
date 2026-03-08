/**
 * MeatSpace POST - Memory Builder Service
 *
 * CRUD and practice tracking for memory items (songs, poems, speeches, sequences).
 * Built-in content: Tom Lehrer's "The Elements" song.
 */

import { writeFile } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { PATHS, ensureDir, readJSONFile } from '../lib/fileUtils.js';

const MEATSPACE_DIR = PATHS.meatspace;
const MEMORY_ITEMS_FILE = join(MEATSPACE_DIR, 'post-memory-items.json');
const TRAINING_LOG_FILE = join(MEATSPACE_DIR, 'post-training-log.json');

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
    ],
    chunks: [
      { id: "verse-1", lineRange: [0, 7], label: "Verse 1" },
      { id: "verse-2", lineRange: [8, 11], label: "Verse 2" },
      { id: "verse-3", lineRange: [12, 15], label: "Verse 3" },
      { id: "verse-4", lineRange: [16, 19], label: "Verse 4" },
      { id: "verse-5", lineRange: [20, 23], label: "Verse 5" },
      { id: "coda", lineRange: [24, 25], label: "Coda" },
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
      No: { name: "Nobelium", atomicNumber: 102 },
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

  // Ensure built-in Elements Song is always present
  const hasElements = items.some(i => i.id === 'elements-song');
  if (!hasElements) {
    items.unshift(structuredClone(ELEMENTS_SONG));
  }

  return items;
}

async function saveMemoryItems(items) {
  await ensureDir(MEATSPACE_DIR);
  await writeFile(MEMORY_ITEMS_FILE, JSON.stringify({ items }, null, 2));
}

async function loadTrainingLog() {
  return readJSONFile(TRAINING_LOG_FILE, { entries: [] }, { allowArray: false });
}

async function saveTrainingLog(log) {
  await ensureDir(MEATSPACE_DIR);
  await writeFile(TRAINING_LOG_FILE, JSON.stringify(log, null, 2));
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

  const item = {
    id: randomUUID(),
    title: data.title,
    type: data.type || 'text',
    builtin: false,
    content: {
      lines: (data.lines || []).map(l => ({
        text: l.text || l,
        ...(l.elements ? { elements: l.elements } : {})
      })),
      chunks: data.chunks || autoChunk(data.lines || []),
    },
    mastery: { overallPct: 0, chunks: {}, elements: {} },
    createdAt: now,
    updatedAt: now,
  };

  items.push(item);
  await saveMemoryItems(items);
  console.log(`🧠 Memory item created: "${item.title}"`);
  return item;
}

export async function updateMemoryItem(id, updates) {
  const items = await loadMemoryItems();
  const idx = items.findIndex(i => i.id === id);
  if (idx === -1) return null;
  if (items[idx].builtin) {
    // Only allow mastery updates on built-in items
    if (updates.mastery) {
      items[idx].mastery = updates.mastery;
      items[idx].updatedAt = new Date().toISOString();
      await saveMemoryItems(items);
      return items[idx];
    }
    return items[idx];
  }

  const item = items[idx];
  if (updates.title) item.title = updates.title;
  if (updates.type) item.type = updates.type;
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
  }

  // Update element-level mastery (for elements song)
  if (results) {
    for (const r of results) {
      if (r.element) {
        if (!item.mastery.elements[r.element]) {
          item.mastery.elements[r.element] = { correct: 0, attempts: 0 };
        }
        item.mastery.elements[r.element].attempts++;
        if (r.correct) item.mastery.elements[r.element].correct++;
      }
    }
  }

  // Recompute overall mastery percentage
  item.mastery.overallPct = computeOverallMastery(item);
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

  console.log(`🧠 Practice logged: "${item.title}" mode=${mode} ${results.filter(r => r.correct).length}/${results.length}`);
  return { mastery: item.mastery, practiceId: log.entries[log.entries.length - 1].id };
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

function generateFillBlank(item, count) {
  const lines = item.content.lines.filter(l => l.text.trim().length > 0);
  if (!lines.length) return null;

  const questions = [];
  const shuffled = [...lines].sort(() => Math.random() - 0.5).slice(0, Math.min(count, lines.length));

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
  const indices = [...Array(lines.length - 1).keys()].sort(() => Math.random() - 0.5).slice(0, Math.min(count, lines.length - 1));

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
  const shuffled = [...elements].sort(() => Math.random() - 0.5).slice(0, Math.min(count, elements.length));

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

function computeOverallMastery(item) {
  // For elements song: mastery is based on per-element accuracy
  if (item.id === 'elements-song' && item.content.elementMap) {
    const totalElements = Object.keys(item.content.elementMap).length;
    if (totalElements === 0) return 0;
    let masteredCount = 0;
    for (const sym of Object.keys(item.content.elementMap)) {
      const m = item.mastery.elements[sym];
      if (m && m.attempts >= 3 && m.correct / m.attempts >= 0.8) masteredCount++;
    }
    return Math.round((masteredCount / totalElements) * 100);
  }

  // For generic items: mastery is based on chunk accuracy
  const chunks = Object.values(item.mastery.chunks);
  if (!chunks.length) return 0;
  const avgAccuracy = chunks.reduce((sum, c) => sum + (c.attempts > 0 ? c.correct / c.attempts : 0), 0) / chunks.length;
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
 * Auto-chunk content into groups of ~4 lines
 */
function autoChunk(lines) {
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

export { ELEMENTS_SONG };
