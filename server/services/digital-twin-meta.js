import { readFile, writeFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import EventEmitter from 'events';
import { digitalTwinMetaSchema } from '../lib/digitalTwinValidation.js';
import { safeJSONParse } from '../lib/fileUtils.js';
import { DIGITAL_TWIN_DIR, generateId, ensureSoulDir } from './digital-twin-helpers.js';

export const META_FILE = join(DIGITAL_TWIN_DIR, 'meta.json');

// Event emitter for digital twin data changes
export const digitalTwinEvents = new EventEmitter();

// In-memory cache
const cache = {
  meta: { data: null, timestamp: 0 },
  documents: { data: null, timestamp: 0 },
  tests: { data: null, timestamp: 0 }
};
export const CACHE_TTL_MS = 5000;

// Expose cache for modules that manage test/document caches (testing.js)
export { cache };

// Default meta structure
export const DEFAULT_META = {
  version: '1.0.0',
  documents: [],
  testHistory: [],
  enrichment: { completedCategories: [], lastSession: null },
  settings: { autoInjectToCoS: true, maxContextTokens: 4000 }
};

export async function loadMeta() {
  if (cache.meta.data && (Date.now() - cache.meta.timestamp) < CACHE_TTL_MS) {
    return cache.meta.data;
  }

  await ensureSoulDir();

  if (!existsSync(META_FILE)) {
    // Scan existing documents and build initial meta
    const meta = await buildInitialMeta();
    await saveMeta(meta);
    return meta;
  }

  const content = await readFile(META_FILE, 'utf-8');
  const parsed = safeJSONParse(content, DEFAULT_META);
  const validated = digitalTwinMetaSchema.safeParse(parsed);

  cache.meta.data = validated.success ? validated.data : { ...DEFAULT_META, ...parsed };
  cache.meta.timestamp = Date.now();
  return cache.meta.data;
}

async function buildInitialMeta() {
  const meta = { ...DEFAULT_META };

  const files = await readdir(DIGITAL_TWIN_DIR).catch(() => []);
  const mdFiles = files.filter(f => f.endsWith('.md'));

  for (const file of mdFiles) {
    const content = await readFile(join(DIGITAL_TWIN_DIR, file), 'utf-8').catch(() => '');
    const title = extractTitle(content) || file.replace('.md', '');
    const category = inferCategory(file);
    const version = extractVersion(content);

    meta.documents.push({
      id: generateId(),
      filename: file,
      title,
      category,
      version,
      enabled: true,
      priority: getPriorityForFile(file),
      weight: 5 // Default weight
    });
  }

  // Sort by priority
  meta.documents.sort((a, b) => a.priority - b.priority);

  return meta;
}

function extractTitle(content) {
  const match = content.match(/^#\s+(.+)/m);
  return match ? match[1].trim() : null;
}

export { extractTitle };

function extractVersion(content) {
  const match = content.match(/\*\*Version:\*\*\s*([\d.]+)/);
  return match ? match[1] : null;
}

export { extractVersion };

function inferCategory(filename) {
  const upper = filename.toUpperCase();

  // Audio/Music
  if (upper.startsWith('AUDIO') || upper.includes('MUSIC')) return 'audio';

  // Behavioral tests
  if (upper.includes('BEHAVIORAL') || upper.includes('TEST_SUITE')) return 'behavioral';

  // Entertainment (movies, books, TV, games)
  if (upper.includes('MOVIE') || upper.includes('FILM') || upper.includes('BOOK') ||
      upper.includes('TV') || upper.includes('GAME') || upper.includes('ENTERTAINMENT')) return 'entertainment';

  // Professional
  if (upper.includes('CAREER') || upper.includes('SKILL') || upper.includes('WORK') ||
      upper.includes('PROFESSIONAL')) return 'professional';

  // Lifestyle
  if (upper.includes('ROUTINE') || upper.includes('HABIT') || upper.includes('HEALTH') ||
      upper.includes('LIFESTYLE') || upper.includes('DAILY')) return 'lifestyle';

  // Social
  if (upper.includes('SOCIAL') || upper.includes('COMMUNICATION') ||
      upper.includes('RELATIONSHIP')) return 'social';

  // Creative
  if (upper.includes('AESTHETIC') || upper.includes('CREATIVE') || upper.includes('ART') ||
      upper.includes('DESIGN')) return 'creative';

  // Enrichment (generic enrichment outputs)
  if (['MEMORIES.md', 'FAVORITES.md', 'PREFERENCES.md'].includes(filename)) return 'enrichment';

  // Default to core identity
  return 'core';
}

function getPriorityForFile(filename) {
  const priorities = {
    'SOUL.md': 1,
    'Expanded.md': 2,
    'BEHAVIORAL_TEST_SUITE.md': 100
  };
  return priorities[filename] || 50;
}

export async function saveMeta(meta) {
  await ensureSoulDir();
  await writeFile(META_FILE, JSON.stringify(meta, null, 2));
  cache.meta.data = meta;
  cache.meta.timestamp = Date.now();
  digitalTwinEvents.emit('meta:changed', meta);
}

export async function updateMeta(updates) {
  const meta = await loadMeta();
  const updated = { ...meta, ...updates };
  await saveMeta(updated);
  return updated;
}

export async function updateSettings(settings) {
  const meta = await loadMeta();
  meta.settings = { ...meta.settings, ...settings };
  await saveMeta(meta);
  return meta.settings;
}
