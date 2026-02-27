/**
 * Digital Twin Service
 *
 * Core business logic for the Digital Twin feature:
 * - Document CRUD (manage digital twin markdown files)
 * - Behavioral testing against LLMs
 * - Enrichment questionnaire system
 * - Export for external LLM use
 * - CoS integration (digital twin context injection)
 */

import { readFile, writeFile, unlink, readdir, mkdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import EventEmitter from 'events';
import { getActiveProvider, getProviderById } from './providers.js';
import { buildPrompt } from './promptService.js';
import {
  digitalTwinMetaSchema,
  documentMetaSchema,
  testHistoryEntrySchema
} from '../lib/digitalTwinValidation.js';
import { safeJSONParse } from '../lib/fileUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DIGITAL_TWIN_DIR = join(__dirname, '../../data/digital-twin');
const META_FILE = join(DIGITAL_TWIN_DIR, 'meta.json');

// Event emitter for digital twin data changes
export const digitalTwinEvents = new EventEmitter();
export const soulEvents = digitalTwinEvents; // Alias for backwards compatibility

// In-memory cache
const cache = {
  meta: { data: null, timestamp: 0 },
  documents: { data: null, timestamp: 0 },
  tests: { data: null, timestamp: 0 }
};
const CACHE_TTL_MS = 5000;

// Default meta structure
const DEFAULT_META = {
  version: '1.0.0',
  documents: [],
  testHistory: [],
  enrichment: { completedCategories: [], lastSession: null },
  settings: { autoInjectToCoS: true, maxContextTokens: 4000 }
};

// Enrichment category configurations
export const ENRICHMENT_CATEGORIES = {
  core_memories: {
    label: 'Core Memories',
    description: 'Formative experiences that shaped your identity',
    targetDoc: 'MEMORIES.md',
    targetCategory: 'enrichment',
    questions: [
      'What childhood memory still influences how you approach problems today?',
      'Describe a pivotal moment that changed your worldview.',
      'What failure taught you the most important lesson?'
    ]
  },
  favorite_books: {
    label: 'Favorite Books',
    description: 'Books that shaped your thinking',
    targetDoc: 'BOOKS.md',
    targetCategory: 'entertainment',
    listBased: true,
    itemLabel: 'Book',
    itemPlaceholder: 'e.g., Gödel, Escher, Bach by Douglas Hofstadter',
    notePlaceholder: 'Why this book matters to you, what it taught you...',
    analyzePrompt: 'Analyze these book choices to understand the reader\'s intellectual interests, values, and worldview.',
    questions: [
      'What book fundamentally changed how you see the world?',
      'Which book do you find yourself re-reading or recommending most?',
      'What fiction shaped your values or aspirations?'
    ]
  },
  favorite_movies: {
    label: 'Favorite Movies',
    description: 'Films that resonate with your aesthetic and values',
    targetDoc: 'MOVIES.md',
    targetCategory: 'entertainment',
    listBased: true,
    itemLabel: 'Movie',
    itemPlaceholder: 'e.g., Blade Runner 2049',
    notePlaceholder: 'What draws you to this film, memorable scenes or themes...',
    analyzePrompt: 'Analyze these film choices to understand the person\'s aesthetic preferences, emotional resonance patterns, and values.',
    questions: [
      'What film captures your aesthetic sensibility?',
      'Which movie do you quote or reference most often?',
      'What film made you think differently about a topic?'
    ]
  },
  music_taste: {
    label: 'Music Taste',
    description: 'Music as cognitive infrastructure',
    targetDoc: 'MUSIC.md',
    targetCategory: 'audio',
    listBased: true,
    itemLabel: 'Album/Artist',
    itemPlaceholder: 'e.g., OK Computer by Radiohead',
    notePlaceholder: 'When you listen to this, how you use it (focus, energy, mood)...',
    analyzePrompt: 'Analyze these music choices to understand how this person uses music for cognitive and emotional regulation.',
    questions: [
      'What album do you use for deep focus work?',
      'What music captures your emotional baseline?',
      'Describe your relationship with music - is it background or active engagement?'
    ]
  },
  communication: {
    label: 'Communication Style',
    description: 'How you prefer to give and receive information',
    targetDoc: 'COMMUNICATION.md',
    targetCategory: 'social',
    questions: [
      'How do you prefer to receive critical feedback?',
      'Do you prefer direct confrontation or diplomatic approach in disagreements?',
      'What communication style irritates you most?'
    ]
  },
  decision_making: {
    label: 'Decision Making',
    description: 'How you approach choices and uncertainty',
    targetDoc: 'PREFERENCES.md',
    targetCategory: 'core',
    questions: [
      'Do you decide quickly with limited info, or deliberate extensively?',
      'How do you handle irreversible decisions differently from reversible ones?',
      'What role does intuition play in your decision-making?'
    ]
  },
  values: {
    label: 'Values',
    description: 'Core principles that guide your actions',
    targetDoc: 'VALUES.md',
    targetCategory: 'core',
    questions: [
      'What are the top three values that guide your most important decisions?',
      'What value do you wish more people held?',
      'Where do you draw the line between pragmatism and principle?'
    ]
  },
  aesthetics: {
    label: 'Aesthetic Preferences',
    description: 'Visual and design sensibilities',
    targetDoc: 'AESTHETICS.md',
    targetCategory: 'creative',
    questions: [
      'Minimalist or maximalist - where do you fall?',
      'What visual style or design movement resonates with you?',
      'How important is aesthetic coherence in your work environment?'
    ]
  },
  daily_routines: {
    label: 'Daily Routines',
    description: 'Habits and rhythms that structure your day',
    targetDoc: 'ROUTINES.md',
    targetCategory: 'lifestyle',
    questions: [
      'Are you a morning person or night owl, and how does this affect your work?',
      'What daily ritual is non-negotiable for your productivity?',
      'How do you recharge - solitude, social, physical activity?'
    ]
  },
  career_skills: {
    label: 'Career & Skills',
    description: 'Professional expertise and growth areas',
    targetDoc: 'CAREER.md',
    targetCategory: 'professional',
    questions: [
      'What are you known for professionally?',
      'What skill are you actively trying to develop?',
      'What unique perspective does your background give you?'
    ]
  },
  non_negotiables: {
    label: 'Non-Negotiables',
    description: 'Principles and boundaries that define your limits',
    targetDoc: 'NON_NEGOTIABLES.md',
    targetCategory: 'core',
    questions: [
      'What principle would you never compromise, even at significant personal cost?',
      'What behavior in others immediately erodes your trust?',
      'What topic should your digital twin absolutely refuse to engage with?'
    ]
  },
  decision_heuristics: {
    label: 'Decision Heuristics',
    description: 'Mental models and shortcuts for making choices',
    targetDoc: 'DECISION_HEURISTICS.md',
    targetCategory: 'core',
    questions: [
      'When facing a decision with limited information, do you act quickly or wait for more data?',
      'How do you weigh reversible vs irreversible decisions differently?',
      'What role does optionality play in your decision-making?'
    ]
  },
  error_intolerance: {
    label: 'Error Intolerance',
    description: 'What your digital twin should never do',
    targetDoc: 'ERROR_INTOLERANCE.md',
    targetCategory: 'core',
    questions: [
      'What communication style or reasoning pattern irritates you most?',
      'What should your digital twin never do when responding to you?',
      'What type of "help" actually makes things worse for you?'
    ]
  },
  personality_assessments: {
    label: 'Personality Assessments',
    description: 'Personality type results from assessments like Myers-Briggs, Big Five, DISC, Enneagram, etc.',
    targetDoc: 'PERSONALITY.md',
    targetCategory: 'core',
    questions: [
      'What is your Myers-Briggs type (e.g., INTJ, ENFP)? If you test differently at different times, list all results.',
      'If you know your Big Five (OCEAN) scores, what are they? High/low on Openness, Conscientiousness, Extraversion, Agreeableness, Neuroticism?',
      'Have you taken other personality assessments (Enneagram, DISC, StrengthsFinder, etc.)? Share those results.'
    ]
  }
};

// Scale questions for Likert-based trait scoring (1-5)
export const SCALE_QUESTIONS = [
  // Big Five — Openness (2 items)
  { id: 'bf-o-1', text: 'I enjoy exploring new ideas and unconventional perspectives.', category: 'personality_assessments', dimension: 'openness', trait: 'O', traitPath: 'bigFive.O', direction: 1, labels: ['Strongly Disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly Agree'] },
  { id: 'bf-o-2', text: 'I prefer familiar routines over trying something new.', category: 'personality_assessments', dimension: 'openness', trait: 'O', traitPath: 'bigFive.O', direction: -1, labels: ['Strongly Disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly Agree'] },
  // Big Five — Conscientiousness (2 items)
  { id: 'bf-c-1', text: 'I keep a detailed plan and follow through on commitments.', category: 'personality_assessments', dimension: 'conscientiousness', trait: 'C', traitPath: 'bigFive.C', direction: 1, labels: ['Strongly Disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly Agree'] },
  { id: 'bf-c-2', text: 'I tend to leave things unfinished or improvise instead of planning.', category: 'personality_assessments', dimension: 'conscientiousness', trait: 'C', traitPath: 'bigFive.C', direction: -1, labels: ['Strongly Disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly Agree'] },
  // Big Five — Extraversion (2 items)
  { id: 'bf-e-1', text: 'I feel energized after spending time with a group of people.', category: 'personality_assessments', dimension: 'extraversion', trait: 'E', traitPath: 'bigFive.E', direction: 1, labels: ['Strongly Disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly Agree'] },
  { id: 'bf-e-2', text: 'I prefer solitary activities over social gatherings.', category: 'personality_assessments', dimension: 'extraversion', trait: 'E', traitPath: 'bigFive.E', direction: -1, labels: ['Strongly Disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly Agree'] },
  // Big Five — Agreeableness (2 items)
  { id: 'bf-a-1', text: 'I go out of my way to help others, even at personal cost.', category: 'personality_assessments', dimension: 'agreeableness', trait: 'A', traitPath: 'bigFive.A', direction: 1, labels: ['Strongly Disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly Agree'] },
  { id: 'bf-a-2', text: 'I prioritize my own goals over group harmony.', category: 'personality_assessments', dimension: 'agreeableness', trait: 'A', traitPath: 'bigFive.A', direction: -1, labels: ['Strongly Disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly Agree'] },
  // Big Five — Neuroticism (2 items)
  { id: 'bf-n-1', text: 'I frequently worry about things that might go wrong.', category: 'personality_assessments', dimension: 'neuroticism', trait: 'N', traitPath: 'bigFive.N', direction: 1, labels: ['Strongly Disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly Agree'] },
  { id: 'bf-n-2', text: 'I stay calm and composed under pressure.', category: 'personality_assessments', dimension: 'neuroticism', trait: 'N', traitPath: 'bigFive.N', direction: -1, labels: ['Strongly Disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly Agree'] },
  // Communication — formality + verbosity (2 items)
  { id: 'comm-f', text: 'I prefer formal, structured language over casual speech.', category: 'communication', dimension: 'communication', trait: 'formality', traitPath: 'communicationProfile.formality', direction: 1, labels: ['Very Casual', 'Casual', 'Balanced', 'Formal', 'Very Formal'] },
  { id: 'comm-v', text: 'I prefer thorough, detailed explanations over brief answers.', category: 'communication', dimension: 'communication', trait: 'verbosity', traitPath: 'communicationProfile.verbosity', direction: 1, labels: ['Very Terse', 'Brief', 'Balanced', 'Detailed', 'Very Elaborate'] },
  // Daily routines — conscientiousness proxy (2 items)
  { id: 'rout-1', text: 'My day follows a consistent structure and set of rituals.', category: 'daily_routines', dimension: 'conscientiousness', trait: 'C', traitPath: 'bigFive.C', direction: 1, labels: ['Strongly Disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly Agree'] },
  { id: 'rout-2', text: 'I adapt my schedule spontaneously based on how I feel.', category: 'daily_routines', dimension: 'conscientiousness', trait: 'C', traitPath: 'bigFive.C', direction: -1, labels: ['Strongly Disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly Agree'] },
  // Values (2 items)
  { id: 'val-1', text: 'I would sacrifice personal gain to uphold a principle.', category: 'values', dimension: 'values', trait: 'values', traitPath: null, direction: 1, labels: ['Strongly Disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly Agree'] },
  { id: 'val-2', text: 'Pragmatism matters more to me than idealism.', category: 'values', dimension: 'values', trait: 'values', traitPath: null, direction: -1, labels: ['Strongly Disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly Agree'] },
  // Decision heuristics (2 items)
  { id: 'dec-1', text: 'I make decisions quickly with available information rather than waiting.', category: 'decision_heuristics', dimension: 'decision_making', trait: 'decision_making', traitPath: null, direction: 1, labels: ['Strongly Disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly Agree'] },
  { id: 'dec-2', text: 'I prefer to gather extensive data before committing to a choice.', category: 'decision_heuristics', dimension: 'decision_making', trait: 'decision_making', traitPath: null, direction: -1, labels: ['Strongly Disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly Agree'] }
];

const SCALE_WEIGHT = 0.3;
const CONFIDENCE_BOOST = 0.15;

// =============================================================================
// HELPERS
// =============================================================================

function generateId() {
  return uuidv4();
}

function now() {
  return new Date().toISOString();
}

async function ensureSoulDir() {
  if (!existsSync(DIGITAL_TWIN_DIR)) {
    await mkdir(DIGITAL_TWIN_DIR, { recursive: true });
    console.log(`🧬 Created soul data directory: ${DIGITAL_TWIN_DIR}`);
  }
}

/**
 * Call any AI provider (API or CLI) with a prompt and return the response text.
 */
async function callProviderAI(provider, model, prompt, { temperature = 0.3, max_tokens = 4000 } = {}) {
  const timeout = provider.timeout || 300000;

  if (provider.type === 'api') {
    const headers = { 'Content-Type': 'application/json' };
    if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(`${provider.endpoint}/chat/completions`, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature,
        max_tokens
      })
    }).catch((err) => {
      clearTimeout(timer);
      return { ok: false, _fetchError: err.name === 'AbortError' ? 'AI request timed out' : err.message };
    });

    clearTimeout(timer);

    if (response._fetchError) {
      return { error: response._fetchError };
    }

    if (!response.ok) {
      return { error: `Provider API error: ${response.status}` };
    }

    const data = await response.json();
    return { text: data.choices?.[0]?.message?.content || '' };
  }

  // CLI provider — pipe prompt via stdin to avoid arg length limits on large prompts
  const { spawn } = await import('child_process');
  return new Promise((resolve) => {
    const args = [...(provider.args || [])];
    let output = '';
    let resolved = false;

    const child = spawn(provider.command, args, {
      env: (() => { const e = { ...process.env, ...provider.envVars }; delete e.CLAUDECODE; return e; })(),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });

    // Pipe prompt via stdin
    child.stdin.write(prompt);
    child.stdin.end();

    child.stdout.on('data', (data) => { output += data.toString(); });
    child.stderr.on('data', (data) => { output += data.toString(); });
    const timeoutHandle = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      child.kill();
      resolve({ error: 'AI request timed out' });
    }, timeout);

    child.on('close', (code) => {
      clearTimeout(timeoutHandle);
      if (resolved) return;
      resolved = true;
      if (code === 0) {
        resolve({ text: output });
      } else {
        resolve({ error: `CLI exited with code ${code}: ${output.substring(0, 500)}` });
      }
    });
    child.on('error', (err) => {
      clearTimeout(timeoutHandle);
      if (resolved) return;
      resolved = true;
      resolve({ error: err.message });
    });
  });
}

// =============================================================================
// META / SETTINGS
// =============================================================================

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

function extractVersion(content) {
  const match = content.match(/\*\*Version:\*\*\s*([\d.]+)/);
  return match ? match[1] : null;
}

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
  soulEvents.emit('meta:changed', meta);
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

// =============================================================================
// DOCUMENT OPERATIONS
// =============================================================================

export async function getDocuments() {
  const meta = await loadMeta();
  const documents = [];

  for (const doc of meta.documents) {
    const filePath = join(DIGITAL_TWIN_DIR, doc.filename);
    const exists = existsSync(filePath);

    if (exists) {
      const stats = await stat(filePath);
      documents.push({
        ...doc,
        lastModified: stats.mtime.toISOString(),
        size: stats.size
      });
    }
  }

  return documents;
}

export async function getDocumentById(id) {
  const meta = await loadMeta();
  const docMeta = meta.documents.find(d => d.id === id);

  if (!docMeta) return null;

  const filePath = join(DIGITAL_TWIN_DIR, docMeta.filename);
  if (!existsSync(filePath)) return null;

  const content = await readFile(filePath, 'utf-8');
  const stats = await stat(filePath);

  return {
    ...docMeta,
    content,
    lastModified: stats.mtime.toISOString(),
    size: stats.size
  };
}

export async function createDocument(data) {
  await ensureSoulDir();

  const meta = await loadMeta();
  const filePath = join(DIGITAL_TWIN_DIR, data.filename);

  // Check if file already exists
  if (existsSync(filePath)) {
    throw new Error(`Document ${data.filename} already exists`);
  }

  // Write the file
  await writeFile(filePath, data.content);

  // Add to meta
  const docMeta = {
    id: generateId(),
    filename: data.filename,
    title: data.title,
    category: data.category,
    version: extractVersion(data.content),
    enabled: data.enabled !== false,
    priority: data.priority || 50,
    weight: data.weight || 5
  };

  meta.documents.push(docMeta);
  meta.documents.sort((a, b) => a.priority - b.priority);
  await saveMeta(meta);

  console.log(`🧬 Created soul document: ${data.filename}`);
  return { ...docMeta, content: data.content };
}

export async function updateDocument(id, updates) {
  const meta = await loadMeta();
  const docIndex = meta.documents.findIndex(d => d.id === id);

  if (docIndex === -1) return null;

  const docMeta = meta.documents[docIndex];
  const filePath = join(DIGITAL_TWIN_DIR, docMeta.filename);

  // Update file content if provided
  if (updates.content) {
    await writeFile(filePath, updates.content);
    docMeta.version = extractVersion(updates.content);
  }

  // Update metadata
  if (updates.title) docMeta.title = updates.title;
  if (updates.enabled !== undefined) docMeta.enabled = updates.enabled;
  if (updates.priority !== undefined) {
    docMeta.priority = updates.priority;
    meta.documents.sort((a, b) => a.priority - b.priority);
  }
  if (updates.weight !== undefined) docMeta.weight = updates.weight;

  meta.documents[docIndex] = docMeta;
  await saveMeta(meta);

  console.log(`🧬 Updated soul document: ${docMeta.filename}`);
  return await getDocumentById(id);
}

export async function deleteDocument(id) {
  const meta = await loadMeta();
  const docIndex = meta.documents.findIndex(d => d.id === id);

  if (docIndex === -1) return false;

  const docMeta = meta.documents[docIndex];
  const filePath = join(DIGITAL_TWIN_DIR, docMeta.filename);

  // Delete file
  if (existsSync(filePath)) {
    await unlink(filePath);
  }

  // Remove from meta
  meta.documents.splice(docIndex, 1);
  await saveMeta(meta);

  console.log(`🧬 Deleted soul document: ${docMeta.filename}`);
  return true;
}

// =============================================================================
// BEHAVIORAL TESTING
// =============================================================================

export async function parseTestSuite() {
  if (cache.tests.data && (Date.now() - cache.tests.timestamp) < CACHE_TTL_MS) {
    return cache.tests.data;
  }

  const testFile = join(DIGITAL_TWIN_DIR, 'BEHAVIORAL_TEST_SUITE.md');
  if (!existsSync(testFile)) {
    return [];
  }

  const content = await readFile(testFile, 'utf-8');
  const tests = [];

  // Parse test blocks using regex
  const testPattern = /### Test (\d+): (.+?)\n\n\*\*Prompt\*\*\s*\n([\s\S]*?)\n\n\*\*Expected Behavior\*\*\s*\n([\s\S]*?)\n\n\*\*Failure Signals\*\*\s*\n([\s\S]*?)(?=\n---|\n### Test|\n## |$)/g;

  let match;
  while ((match = testPattern.exec(content)) !== null) {
    tests.push({
      testId: parseInt(match[1], 10),
      testName: match[2].trim(),
      prompt: match[3].trim().replace(/^"|"$/g, ''),
      expectedBehavior: match[4].trim(),
      failureSignals: match[5].trim()
    });
  }

  cache.tests.data = tests;
  cache.tests.timestamp = Date.now();

  return tests;
}

export async function runTests(providerId, model, testIds = null) {
  const tests = await parseTestSuite();
  const soulContext = await getSoulForPrompt();

  const provider = await getProviderById(providerId);
  if (!provider || !provider.enabled) {
    throw new Error(`Provider ${providerId} not found or disabled`);
  }

  // Filter tests if specific IDs provided
  const testsToRun = testIds
    ? tests.filter(t => testIds.includes(t.testId))
    : tests;

  const results = [];
  let passed = 0, failed = 0, partial = 0;

  for (const test of testsToRun) {
    const result = await runSingleTest(test, soulContext, providerId, model);
    results.push(result);

    if (result.result === 'passed') passed++;
    else if (result.result === 'failed') failed++;
    else if (result.result === 'partial') partial++;
  }

  // Save to history
  const historyEntry = {
    runId: generateId(),
    providerId,
    model,
    score: testsToRun.length > 0 ? (passed + partial * 0.5) / testsToRun.length : 0,
    passed,
    failed,
    partial,
    total: testsToRun.length,
    timestamp: now()
  };

  const meta = await loadMeta();
  meta.testHistory.unshift(historyEntry);
  meta.testHistory = meta.testHistory.slice(0, 50); // Keep last 50 runs
  await saveMeta(meta);

  console.log(`🧬 Test run complete: ${passed}/${testsToRun.length} passed`);

  return {
    ...historyEntry,
    results
  };
}

async function runSingleTest(test, soulContext, providerId, model) {
  const provider = await getProviderById(providerId);

  // Combine system prompt with user prompt for callProviderAI (single-message interface)
  const combinedPrompt = `You are embodying the following identity. Respond as this person would, based on the soul document below:\n\n${soulContext}\n\nUser: ${test.prompt}`;

  const result = await callProviderAI(provider, model, combinedPrompt, { temperature: 0.7, max_tokens: 1000 });
  if (result.error) {
    throw new Error(result.error);
  }

  const response = result.text || '';

  // Score the response
  const scoring = await scoreTestResponse(test, response, providerId, model);

  return {
    testId: test.testId,
    testName: test.testName,
    prompt: test.prompt,
    expectedBehavior: test.expectedBehavior,
    failureSignals: test.failureSignals,
    response,
    result: scoring.result,
    reasoning: scoring.reasoning
  };
}

async function scoreTestResponse(test, response, providerId, model) {
  // Use AI to score the response
  const prompt = await buildPrompt('soul-test-scorer', {
    testName: test.testName,
    prompt: test.prompt,
    expectedBehavior: test.expectedBehavior,
    failureSignals: test.failureSignals,
    response: response.substring(0, 2000) // Truncate for scoring
  }).catch(() => null);

  if (!prompt) {
    // Fallback: simple keyword matching
    const hasFailureSignals = test.failureSignals.toLowerCase().split('\n')
      .some(signal => response.toLowerCase().includes(signal.trim().slice(2)));

    return {
      result: hasFailureSignals ? 'failed' : 'passed',
      reasoning: 'Automated keyword matching (prompt template unavailable)'
    };
  }

  const provider = await getProviderById(providerId);
  const result = await callProviderAI(provider, model, prompt, { temperature: 0.1, max_tokens: 500 });

  if (!result.error && result.text) {
    return parseScoreResponse(result.text);
  }

  // Default fallback
  return { result: 'partial', reasoning: 'Unable to score - defaulting to partial' };
}

function parseScoreResponse(response) {
  const lower = response.toLowerCase();

  let result = 'partial';
  if (lower.includes('"result": "passed"') || lower.includes('result: passed')) {
    result = 'passed';
  } else if (lower.includes('"result": "failed"') || lower.includes('result: failed')) {
    result = 'failed';
  }

  // Extract reasoning
  const reasoningMatch = response.match(/"reasoning":\s*"([^"]+)"/);
  const reasoning = reasoningMatch ? reasoningMatch[1] : response.substring(0, 200);

  return { result, reasoning };
}

export async function getTestHistory(limit = 10) {
  const meta = await loadMeta();
  return meta.testHistory.slice(0, limit);
}

// =============================================================================
// ENRICHMENT
// =============================================================================

export function getEnrichmentCategories() {
  return Object.entries(ENRICHMENT_CATEGORIES).map(([key, config]) => ({
    id: key,
    label: config.label,
    description: config.description,
    targetDoc: config.targetDoc,
    sampleQuestions: config.questions.length,
    // List-based category config
    listBased: config.listBased || false,
    itemLabel: config.itemLabel,
    itemPlaceholder: config.itemPlaceholder,
    notePlaceholder: config.notePlaceholder
  }));
}

export async function generateEnrichmentQuestion(category, providerOverride, modelOverride, skipIndices = []) {
  const config = ENRICHMENT_CATEGORIES[category];
  if (!config) {
    throw new Error(`Unknown enrichment category: ${category}`);
  }

  const meta = await loadMeta();
  const questionsAnswered = meta.enrichment.questionsAnswered?.[category] || 0;
  const skipped = new Set(skipIndices);

  // Use predefined questions first
  if (questionsAnswered < config.questions.length) {
    // Find the next non-skipped predefined question
    let idx = questionsAnswered;
    while (idx < config.questions.length && skipped.has(idx)) idx++;
    if (idx < config.questions.length) {
      return {
        questionId: generateId(),
        category,
        question: config.questions[idx],
        questionIndex: idx,
        isGenerated: false,
        questionNumber: questionsAnswered + 1,
        totalQuestions: config.questions.length
      };
    }
    // All remaining predefined questions were skipped — fall through to scale/AI
  }

  // Serve unanswered scale questions for this category
  const answered = meta.enrichment.scaleQuestionsAnswered || {};
  const categoryScaleQuestions = SCALE_QUESTIONS.filter(q => q.category === category);
  const unanswered = categoryScaleQuestions.filter(q => !(q.id in answered));
  // Filter out skipped scale questions (stored as negative indices: -(scaleIndex+1))
  const available = unanswered.filter((_, i) => !skipped.has(-(i + 1)));
  if (available.length > 0) {
    const sq = available[0];
    const scaleIndex = unanswered.indexOf(sq);
    return {
      questionId: generateId(),
      category,
      question: sq.text,
      questionType: 'scale',
      labels: sq.labels,
      dimension: sq.dimension,
      scaleQuestionId: sq.id,
      scaleIndex,
      isGenerated: false,
      questionNumber: questionsAnswered + 1,
      totalQuestions: config.questions.length + categoryScaleQuestions.length
    };
  }

  // Check if fallback was already served (all structured questions exhausted + at least one AI/fallback answered)
  const structuredTotal = config.questions.length + categoryScaleQuestions.length;
  const fallbackAlreadyAnswered = questionsAnswered > structuredTotal;

  // Generate follow-up question using AI
  const existingSoul = await getSoulForPrompt({ maxTokens: 2000 });

  const prompt = await buildPrompt('soul-enrichment', {
    category,
    categoryLabel: config.label,
    categoryDescription: config.description,
    existingSoul,
    questionsAnswered
  }).catch(() => null);

  if (!prompt) {
    // Only serve the generic fallback once — if already answered, signal category is done
    if (fallbackAlreadyAnswered) return null;
    return {
      questionId: generateId(),
      category,
      question: `What else should your digital twin know about your ${config.label.toLowerCase()}?`,
      isGenerated: true,
      questionNumber: questionsAnswered + 1,
      totalQuestions: null
    };
  }

  const provider = providerOverride
    ? await getProviderById(providerOverride)
    : await getActiveProvider();

  if (!provider) {
    throw new Error('No AI provider available');
  }

  const model = modelOverride || provider.defaultModel;

  const fallbackText = `What else should your digital twin know about your ${config.label.toLowerCase()}?`;
  let question = null;

  const result = await callProviderAI(provider, model, prompt, { temperature: 0.8, max_tokens: 200 });
  if (!result.error && result.text) {
    question = result.text.trim() || null;
  }

  // If AI didn't produce a question, use generic fallback (but only once)
  if (!question) {
    if (fallbackAlreadyAnswered) return null;
    question = fallbackText;
  }

  return {
    questionId: generateId(),
    category,
    question,
    isGenerated: true,
    questionNumber: questionsAnswered + 1,
    totalQuestions: null // Unlimited for generated questions
  };
}

async function processScaleAnswer(data) {
  const { category, question, scaleValue, scaleQuestionId } = data;
  const config = ENRICHMENT_CATEGORIES[category];
  if (!config) throw new Error(`Unknown enrichment category: ${category}`);

  const scaleDef = SCALE_QUESTIONS.find(q => q.id === scaleQuestionId);
  if (!scaleDef) throw new Error(`Unknown scale question: ${scaleQuestionId}`);

  // Convert 1-5 to 0-1, apply direction
  const rawScore = (scaleValue - 1) / 4;
  const adjustedScore = scaleDef.direction === 1 ? rawScore : (1 - rawScore);

  const meta = await loadMeta();
  if (!meta.traits) meta.traits = {};

  // Update trait score via weighted moving average
  if (scaleDef.traitPath) {
    const parts = scaleDef.traitPath.split('.');
    const section = parts[0]; // e.g. 'bigFive' or 'communicationProfile'
    const field = parts[1];   // e.g. 'O' or 'formality'

    if (!meta.traits[section]) meta.traits[section] = {};
    const existing = meta.traits[section][field];

    // communicationProfile fields are integer 1-10
    if (section === 'communicationProfile') {
      const mapped = Math.round(adjustedScore * 9) + 1; // 1-10
      meta.traits[section][field] = existing == null
        ? mapped
        : Math.round(existing * (1 - SCALE_WEIGHT) + mapped * SCALE_WEIGHT);
    } else {
      meta.traits[section][field] = existing == null
        ? Math.round(adjustedScore * 100) / 100
        : Math.round((existing * (1 - SCALE_WEIGHT) + adjustedScore * SCALE_WEIGHT) * 100) / 100;
    }

    meta.traits.lastAnalyzed = now();
  }

  // Boost confidence for the dimension
  if (!meta.confidence) meta.confidence = { overall: 0, dimensions: {}, gaps: [], lastCalculated: now() };
  if (!meta.confidence.dimensions) meta.confidence.dimensions = {};
  const currentConf = meta.confidence.dimensions[scaleDef.dimension] || 0;
  meta.confidence.dimensions[scaleDef.dimension] = Math.min(1, Math.round((currentConf + CONFIDENCE_BOOST) * 100) / 100);

  // Recalculate overall confidence
  const dimValues = Object.values(meta.confidence.dimensions);
  meta.confidence.overall = dimValues.length > 0
    ? Math.round((dimValues.reduce((a, b) => a + b, 0) / dimValues.length) * 100) / 100
    : 0;

  // Regenerate gap recommendations
  meta.confidence.gaps = generateGapRecommendations(meta.confidence.dimensions);
  meta.confidence.lastCalculated = now();

  // Store readable line in target document
  const labelText = scaleDef.labels[scaleValue - 1] || String(scaleValue);
  const formattedContent = `### ${question}\n\nResponse: ${labelText} (${scaleValue}/5)\n\n`;

  await ensureSoulDir();
  const targetPath = join(DIGITAL_TWIN_DIR, config.targetDoc);
  let existingContent = '';
  if (existsSync(targetPath)) {
    existingContent = await readFile(targetPath, 'utf-8');
  } else {
    existingContent = `# ${config.label}\n\n`;
  }
  await writeFile(targetPath, existingContent + '\n' + formattedContent);

  // Record scale answer
  if (!meta.enrichment.scaleQuestionsAnswered) meta.enrichment.scaleQuestionsAnswered = {};
  meta.enrichment.scaleQuestionsAnswered[scaleQuestionId] = scaleValue;

  // Increment questions answered for the category
  if (!meta.enrichment.questionsAnswered) meta.enrichment.questionsAnswered = {};
  meta.enrichment.questionsAnswered[category] = (meta.enrichment.questionsAnswered[category] || 0) + 1;
  meta.enrichment.lastSession = now();

  if (meta.enrichment.questionsAnswered[category] >= 3 &&
      !meta.enrichment.completedCategories.includes(category)) {
    meta.enrichment.completedCategories.push(category);
  }

  // Ensure document is in meta
  const existingDoc = meta.documents.find(d => d.filename === config.targetDoc);
  if (!existingDoc) {
    meta.documents.push({
      id: generateId(),
      filename: config.targetDoc,
      title: config.label,
      category: config.targetCategory || 'enrichment',
      enabled: true,
      priority: 30
    });
  }

  await saveMeta(meta);

  digitalTwinEvents.emit('traits:updated', meta.traits);
  digitalTwinEvents.emit('confidence:calculated', meta.confidence);

  console.log(`📊 Scale answer processed: ${scaleQuestionId}=${scaleValue} → ${scaleDef.dimension} confidence=${meta.confidence.dimensions[scaleDef.dimension]}`);

  return {
    category,
    targetDoc: config.targetDoc,
    contentAdded: formattedContent,
    traitsUpdated: true,
    dimension: scaleDef.dimension,
    newConfidence: meta.confidence.dimensions[scaleDef.dimension]
  };
}

export async function processEnrichmentAnswer(data) {
  // Branch for scale questions
  if (data.questionType === 'scale') return processScaleAnswer(data);

  const { category, question, answer, providerOverride, modelOverride } = data;
  const config = ENRICHMENT_CATEGORIES[category];

  if (!config) {
    throw new Error(`Unknown enrichment category: ${category}`);
  }

  // Generate content to add to the target document
  const provider = providerOverride
    ? await getProviderById(providerOverride)
    : await getActiveProvider();

  let formattedContent = `### ${question}\n\n${answer}\n\n`;

  if (provider) {
    const prompt = await buildPrompt('soul-enrichment-process', {
      category,
      categoryLabel: config.label,
      question,
      answer
    }).catch(() => null);

    if (prompt) {
      const result = await callProviderAI(provider, providerOverride || provider.defaultModel, prompt, { temperature: 0.3, max_tokens: 500 });
      if (!result.error && result.text) {
        formattedContent = result.text.trim() || formattedContent;
      }
    }
  }

  // Append to target document
  const targetPath = join(DIGITAL_TWIN_DIR, config.targetDoc);
  let existingContent = '';

  if (existsSync(targetPath)) {
    existingContent = await readFile(targetPath, 'utf-8');
  } else {
    existingContent = `# ${config.label}\n\n`;
  }

  await writeFile(targetPath, existingContent + '\n' + formattedContent);

  // Update meta
  const meta = await loadMeta();
  if (!meta.enrichment.questionsAnswered) {
    meta.enrichment.questionsAnswered = {};
  }
  meta.enrichment.questionsAnswered[category] =
    (meta.enrichment.questionsAnswered[category] || 0) + 1;
  meta.enrichment.lastSession = now();

  // Check if we've completed a category (3+ questions answered)
  if (meta.enrichment.questionsAnswered[category] >= 3 &&
      !meta.enrichment.completedCategories.includes(category)) {
    meta.enrichment.completedCategories.push(category);
  }

  // Ensure document is in meta
  const existingDoc = meta.documents.find(d => d.filename === config.targetDoc);
  if (!existingDoc) {
    meta.documents.push({
      id: generateId(),
      filename: config.targetDoc,
      title: config.label,
      category: config.targetCategory || 'enrichment',
      enabled: true,
      priority: 30
    });
  }

  // Boost confidence for the dimension this category maps to
  const categoryToDimension = {
    personality_assessments: 'openness',
    daily_routines: 'conscientiousness',
    communication: 'communication',
    values: 'values',
    non_negotiables: 'boundaries',
    decision_heuristics: 'decision_making',
    error_intolerance: 'boundaries',
    core_memories: 'identity',
    career_skills: 'conscientiousness',
    taste: 'openness'
  };
  const dimension = categoryToDimension[category];
  if (dimension) {
    if (!meta.confidence) meta.confidence = { overall: 0, dimensions: {}, gaps: [], lastCalculated: now() };
    if (!meta.confidence.dimensions) meta.confidence.dimensions = {};
    const currentConf = meta.confidence.dimensions[dimension] || 0;
    meta.confidence.dimensions[dimension] = Math.min(1, Math.round((currentConf + CONFIDENCE_BOOST) * 100) / 100);

    const dimValues = Object.values(meta.confidence.dimensions);
    meta.confidence.overall = dimValues.length > 0
      ? Math.round((dimValues.reduce((a, b) => a + b, 0) / dimValues.length) * 100) / 100
      : 0;

    meta.confidence.gaps = generateGapRecommendations(meta.confidence.dimensions);
    meta.confidence.lastCalculated = now();
  }

  await saveMeta(meta);

  digitalTwinEvents.emit('confidence:calculated', meta.confidence);

  console.log(`🧬 Enrichment answer processed for ${category}${dimension ? ` → ${dimension} confidence=${meta.confidence.dimensions[dimension]}` : ''}`);

  return {
    category,
    targetDoc: config.targetDoc,
    contentAdded: formattedContent,
    dimension,
    newConfidence: dimension ? meta.confidence.dimensions[dimension] : undefined
  };
}

export async function getEnrichmentProgress() {
  const meta = await loadMeta();
  const categories = Object.keys(ENRICHMENT_CATEGORIES);

  const progress = {};
  for (const cat of categories) {
    const config = ENRICHMENT_CATEGORIES[cat];
    const answered = meta.enrichment.questionsAnswered?.[cat] || 0;
    const baseQuestions = config.questions.length;
    progress[cat] = {
      answered,
      baseQuestions,
      listBased: !!config.listBased,
      completed: meta.enrichment.completedCategories.includes(cat),
      percentage: Math.min(100, Math.round((answered / baseQuestions) * 100))
    };
  }

  return {
    categories: progress,
    completedCount: meta.enrichment.completedCategories.length,
    totalCategories: categories.length,
    lastSession: meta.enrichment.lastSession
  };
}

/**
 * Analyze a list of items (books, movies, music) and generate document content
 * @param {string} category - The enrichment category
 * @param {Array} items - Array of { title, note } objects
 * @param {string} providerId - Provider to use for analysis
 * @param {string} model - Model to use
 * @returns {Object} - { analysis, suggestedContent, items }
 */
export async function analyzeEnrichmentList(category, items, providerId, model) {
  const config = ENRICHMENT_CATEGORIES[category];
  if (!config) {
    throw new Error(`Unknown enrichment category: ${category}`);
  }

  if (!config.listBased) {
    throw new Error(`Category ${category} does not support list-based enrichment`);
  }

  if (!items || items.length === 0) {
    throw new Error('No items provided');
  }

  const provider = await getProviderById(providerId);
  if (!provider || !provider.enabled) {
    throw new Error('Provider not found or disabled');
  }

  // Format items for the prompt
  const itemsList = items.map((item, i) => {
    let entry = `${i + 1}. ${item.title}`;
    if (item.note) {
      entry += `\n   User's note: ${item.note}`;
    }
    return entry;
  }).join('\n\n');

  // Build the analysis prompt
  const prompt = `You are analyzing someone's ${config.label.toLowerCase()} to understand their personality, values, and preferences.

${config.analyzePrompt}

## Items provided:

${itemsList}

## Your task:

1. **Analysis**: For each item, briefly note what it might reveal about the person (themes, values, intellectual interests, emotional patterns).

2. **Patterns**: Identify 3-5 overarching patterns or themes across all choices.

3. **Personality Insights**: What does this collection suggest about the person's:
   - Intellectual interests and curiosities
   - Values and worldview
   - Aesthetic preferences
   - Emotional landscape

4. **Generate Document**: Create a markdown document for ${config.targetDoc} that captures these insights in a format useful for an AI digital twin.

Respond in JSON format:
\`\`\`json
{
  "itemAnalysis": [
    { "title": "...", "insights": "..." }
  ],
  "patterns": ["pattern 1", "pattern 2", ...],
  "personalityInsights": {
    "intellectualInterests": "...",
    "valuesWorldview": "...",
    "aestheticPreferences": "...",
    "emotionalLandscape": "..."
  },
  "suggestedDocument": "# ${config.label}\\n\\n..."
}
\`\`\``;

  const result = await callProviderAI(provider, model, prompt, { temperature: 0.7, max_tokens: 3000 });
  if (result.error) {
    throw new Error(result.error);
  }

  const responseText = result.text || '';

  // Parse the JSON response
  const jsonMatch = responseText.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    const parsed = safeJSONParse(jsonMatch[1], null, { logError: true, context: 'enrichment analysis' });
    if (parsed) {
      return {
        category,
        items,
        itemAnalysis: parsed.itemAnalysis || [],
        patterns: parsed.patterns || [],
        personalityInsights: parsed.personalityInsights || {},
        suggestedDocument: parsed.suggestedDocument || '',
        targetDoc: config.targetDoc,
        targetCategory: config.targetCategory
      };
    }
  }

  // Fallback if JSON parsing fails
  return {
    category,
    items,
    rawResponse: responseText,
    suggestedDocument: responseText,
    targetDoc: config.targetDoc,
    targetCategory: config.targetCategory
  };
}

/**
 * Save analyzed list content to document
 */
export async function saveEnrichmentListDocument(category, content, items) {
  const config = ENRICHMENT_CATEGORIES[category];
  if (!config) {
    throw new Error(`Unknown enrichment category: ${category}`);
  }

  await ensureSoulDir();

  const targetPath = join(DIGITAL_TWIN_DIR, config.targetDoc);
  await writeFile(targetPath, content);

  // Update meta
  const meta = await loadMeta();

  // Mark as completed since they provided a full list
  if (!meta.enrichment.completedCategories.includes(category)) {
    meta.enrichment.completedCategories.push(category);
  }

  // Store the list items for future reference/editing
  if (!meta.enrichment.listItems) {
    meta.enrichment.listItems = {};
  }
  meta.enrichment.listItems[category] = items;

  // Track items as answered questions so progress displays correctly
  if (!meta.enrichment.questionsAnswered) meta.enrichment.questionsAnswered = {};
  meta.enrichment.questionsAnswered[category] = items.length;

  meta.enrichment.lastSession = now();

  // Ensure document is in meta
  const existingDoc = meta.documents.find(d => d.filename === config.targetDoc);
  if (!existingDoc) {
    meta.documents.push({
      id: generateId(),
      filename: config.targetDoc,
      title: config.label,
      category: config.targetCategory || 'enrichment',
      enabled: true,
      priority: 30
    });
  }

  await saveMeta(meta);

  console.log(`🧬 Saved list-based enrichment for ${category} (${items.length} items)`);

  return {
    category,
    targetDoc: config.targetDoc,
    itemCount: items.length
  };
}

/**
 * Get previously saved list items for a category
 */
export async function getEnrichmentListItems(category) {
  const meta = await loadMeta();
  return meta.enrichment.listItems?.[category] || [];
}

// =============================================================================
// EXPORT
// =============================================================================

export function getExportFormats() {
  return [
    { id: 'system_prompt', label: 'System Prompt', description: 'Combined markdown for direct injection' },
    { id: 'claude_md', label: 'CLAUDE.md', description: 'Format for Claude Code integration' },
    { id: 'json', label: 'JSON', description: 'Structured JSON for API integration' },
    { id: 'individual', label: 'Individual Files', description: 'Separate files for each document' }
  ];
}

export async function exportDigitalTwin(format, documentIds = null, includeDisabled = false) {
  const meta = await loadMeta();
  let docs = meta.documents;

  // Filter by IDs if provided
  if (documentIds) {
    docs = docs.filter(d => documentIds.includes(d.id));
  }

  // Filter disabled unless explicitly included
  if (!includeDisabled) {
    docs = docs.filter(d => d.enabled);
  }

  // Exclude behavioral test suite from exports
  docs = docs.filter(d => d.category !== 'behavioral');

  // Sort by priority
  docs.sort((a, b) => a.priority - b.priority);

  // Load content for each document
  const documentsWithContent = [];
  for (const doc of docs) {
    const filePath = join(DIGITAL_TWIN_DIR, doc.filename);
    if (existsSync(filePath)) {
      const content = await readFile(filePath, 'utf-8');
      documentsWithContent.push({ ...doc, content });
    }
  }

  switch (format) {
    case 'system_prompt':
      return exportAsSystemPrompt(documentsWithContent);
    case 'claude_md':
      return exportAsClaudeMd(documentsWithContent);
    case 'json':
      return exportAsJson(documentsWithContent);
    case 'individual':
      return exportAsIndividual(documentsWithContent);
    default:
      throw new Error(`Unknown export format: ${format}`);
  }
}

function exportAsSystemPrompt(docs) {
  let output = '# User Identity & Persona (Soul)\n\n';
  output += 'The following describes the identity, values, and preferences of the user you are assisting. ';
  output += 'Use this context to align your responses with their communication style, values, and goals.\n\n';
  output += '---\n\n';

  for (const doc of docs) {
    output += doc.content + '\n\n---\n\n';
  }

  return {
    format: 'system_prompt',
    content: output.trim(),
    documentCount: docs.length,
    tokenEstimate: Math.ceil(output.length / 4)
  };
}

function exportAsClaudeMd(docs) {
  let output = '# Soul - User Identity\n\n';
  output += '> This section defines the identity, values, and preferences of the user.\n\n';

  for (const doc of docs) {
    // Remove the main header from each doc to avoid duplication
    const content = doc.content.replace(/^#\s+.+\n+/, '');
    output += `## ${doc.title}\n\n${content}\n\n`;
  }

  return {
    format: 'claude_md',
    content: output.trim(),
    documentCount: docs.length,
    tokenEstimate: Math.ceil(output.length / 4)
  };
}

function exportAsJson(docs) {
  const structured = {
    version: '1.0.0',
    exportedAt: now(),
    documents: docs.map(doc => ({
      id: doc.id,
      title: doc.title,
      category: doc.category,
      content: doc.content
    })),
    metadata: {
      totalDocuments: docs.length,
      categories: [...new Set(docs.map(d => d.category))]
    }
  };

  const jsonString = JSON.stringify(structured, null, 2);

  return {
    format: 'json',
    content: jsonString,
    documentCount: docs.length,
    tokenEstimate: Math.ceil(jsonString.length / 4)
  };
}
export const exportSoul = exportDigitalTwin; // Alias for backwards compatibility

function exportAsIndividual(docs) {
  return {
    format: 'individual',
    files: docs.map(doc => ({
      filename: doc.filename,
      title: doc.title,
      category: doc.category,
      content: doc.content
    })),
    documentCount: docs.length,
    tokenEstimate: docs.reduce((sum, d) => sum + Math.ceil(d.content.length / 4), 0)
  };
}

// =============================================================================
// COS INTEGRATION
// =============================================================================

export async function getDigitalTwinForPrompt(options = {}) {
  const { maxTokens = 4000 } = options;
  const meta = await loadMeta();

  if (!meta.settings.autoInjectToCoS) {
    return '';
  }

  // Get enabled documents sorted by weight (desc) then priority (asc)
  // Higher weight = more important = included first
  const docs = meta.documents
    .filter(d => d.enabled && d.category !== 'behavioral')
    .sort((a, b) => {
      const weightA = a.weight || 5;
      const weightB = b.weight || 5;
      if (weightB !== weightA) return weightB - weightA; // Higher weight first
      return a.priority - b.priority; // Then by priority
    });

  let output = '';
  let tokenCount = 0;
  const maxChars = maxTokens * 4; // Rough char-to-token estimate

  for (const doc of docs) {
    const filePath = join(DIGITAL_TWIN_DIR, doc.filename);
    if (!existsSync(filePath)) continue;

    const content = await readFile(filePath, 'utf-8');

    if (tokenCount + content.length > maxChars) {
      // Truncate if we're over budget
      const remaining = maxChars - tokenCount;
      if (remaining > 500) {
        output += content.substring(0, remaining) + '\n\n[Truncated due to token limit]\n';
      }
      break;
    }

    output += content + '\n\n---\n\n';
    tokenCount += content.length;
  }

  return output.trim();
}
export const getSoulForPrompt = getDigitalTwinForPrompt; // Alias for backwards compatibility

// =============================================================================
// STATUS & SUMMARY
// =============================================================================

export async function getDigitalTwinStatus() {
  const meta = await loadMeta();
  const documents = await getDocuments();
  const testHistory = meta.testHistory.slice(0, 5);
  const enrichmentProgress = await getEnrichmentProgress();

  // Calculate health score
  const docScore = Math.min(1, documents.filter(d => d.enabled).length / 5);
  const testScore = testHistory.length > 0 ? testHistory[0].score : 0;
  const enrichScore = enrichmentProgress.completedCount / enrichmentProgress.totalCategories;

  const healthScore = Math.round(((docScore + testScore + enrichScore) / 3) * 100);

  return {
    healthScore,
    documentCount: documents.length,
    enabledDocuments: documents.filter(d => d.enabled).length,
    documentsByCategory: {
      core: documents.filter(d => d.category === 'core').length,
      audio: documents.filter(d => d.category === 'audio').length,
      behavioral: documents.filter(d => d.category === 'behavioral').length,
      enrichment: documents.filter(d => d.category === 'enrichment').length
    },
    lastTestRun: testHistory[0] || null,
    enrichmentProgress: {
      completedCategories: enrichmentProgress.completedCount,
      totalCategories: enrichmentProgress.totalCategories
    },
    settings: meta.settings
  };
}
export const getSoulStatus = getDigitalTwinStatus; // Alias for backwards compatibility

// =============================================================================
// VALIDATION & ANALYSIS
// =============================================================================

// Required sections for a complete digital twin
const REQUIRED_SECTIONS = [
  {
    id: 'identity',
    label: 'Identity Basics',
    description: 'Name, role, and one-liner description',
    keywords: ['name', 'role', 'who i am', 'identity', 'about me'],
    suggestedEnrichment: null,
    suggestedDoc: 'SOUL.md'
  },
  {
    id: 'values',
    label: 'Core Values',
    description: 'At least 3 clearly defined principles',
    keywords: ['values', 'principles', 'believe', 'important to me'],
    suggestedEnrichment: 'values',
    suggestedDoc: 'VALUES.md'
  },
  {
    id: 'communication',
    label: 'Communication Style',
    description: 'How you prefer to give and receive information',
    keywords: ['communication', 'prefer', 'feedback', 'style', 'tone'],
    suggestedEnrichment: 'communication',
    suggestedDoc: 'COMMUNICATION.md'
  },
  {
    id: 'decision_making',
    label: 'Decision Making',
    description: 'How you approach choices and uncertainty',
    keywords: ['decision', 'choose', 'uncertainty', 'risk', 'intuition'],
    suggestedEnrichment: 'decision_heuristics',
    suggestedDoc: 'DECISION_HEURISTICS.md'
  },
  {
    id: 'non_negotiables',
    label: 'Non-Negotiables',
    description: 'Principles and boundaries you never compromise',
    keywords: ['non-negotiable', 'never', 'boundary', 'refuse', 'limit'],
    suggestedEnrichment: 'non_negotiables',
    suggestedDoc: 'NON_NEGOTIABLES.md'
  },
  {
    id: 'error_intolerance',
    label: 'Error Intolerance',
    description: 'What your digital twin should never do',
    keywords: ['never do', 'irritate', 'annoy', 'hate', 'worst'],
    suggestedEnrichment: 'error_intolerance',
    suggestedDoc: 'ERROR_INTOLERANCE.md'
  }
];

export async function validateCompleteness() {
  const documents = await getDocuments();
  const enabledDocs = documents.filter(d => d.enabled && d.category !== 'behavioral');

  // Load content for all enabled documents
  const contents = [];
  for (const doc of enabledDocs) {
    const filePath = join(DIGITAL_TWIN_DIR, doc.filename);
    if (existsSync(filePath)) {
      const content = await readFile(filePath, 'utf-8');
      contents.push({ doc, content: content.toLowerCase() });
    }
  }

  const allContent = contents.map(c => c.content).join('\n');
  const found = [];
  const missing = [];

  for (const section of REQUIRED_SECTIONS) {
    const hasKeywords = section.keywords.some(kw => allContent.includes(kw.toLowerCase()));
    const hasDoc = enabledDocs.some(d =>
      d.filename.toLowerCase().includes(section.id.replace('_', '')) ||
      d.title.toLowerCase().includes(section.label.toLowerCase())
    );

    if (hasKeywords || hasDoc) {
      found.push(section.id);
    } else {
      missing.push({
        id: section.id,
        label: section.label,
        description: section.description,
        suggestion: section.suggestedEnrichment
          ? `Answer questions in the "${ENRICHMENT_CATEGORIES[section.suggestedEnrichment]?.label}" enrichment category`
          : `Create a ${section.suggestedDoc} document`,
        enrichmentCategory: section.suggestedEnrichment
      });
    }
  }

  const score = Math.round((found.length / REQUIRED_SECTIONS.length) * 100);

  return {
    score,
    total: REQUIRED_SECTIONS.length,
    found: found.length,
    missing,
    suggestions: missing.map(m => m.suggestion)
  };
}

export async function detectContradictions(providerId, model) {
  const documents = await getDocuments();
  const enabledDocs = documents.filter(d => d.enabled && d.category !== 'behavioral');

  if (enabledDocs.length < 2) {
    return { issues: [], message: 'Need at least 2 documents to detect contradictions' };
  }

  // Load all document contents
  let combinedContent = '';
  for (const doc of enabledDocs) {
    const filePath = join(DIGITAL_TWIN_DIR, doc.filename);
    if (existsSync(filePath)) {
      const content = await readFile(filePath, 'utf-8');
      combinedContent += `\n\n## Document: ${doc.filename}\n\n${content}`;
    }
  }

  // Build the prompt
  const prompt = await buildPrompt('soul-contradiction-detector', {
    soulContent: combinedContent.substring(0, 15000) // Limit to avoid token limits
  }).catch(() => null);

  if (!prompt) {
    return { issues: [], error: 'Contradiction detector prompt template not found' };
  }

  const provider = await getProviderById(providerId);
  if (!provider || !provider.enabled) {
    return { issues: [], error: 'Provider not found or disabled' };
  }

  const result = await callProviderAI(provider, model, prompt, { temperature: 0.3, max_tokens: 2000 });
  if (!result.error && result.text) {
    return parseContradictionResponse(result.text);
  }

  return { issues: [], error: result.error || 'Failed to analyze contradictions' };
}

function parseContradictionResponse(response) {
  // Try to extract JSON from the response
  const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    const parsed = safeJSONParse(jsonMatch[1], null, { logError: true, context: 'contradiction analysis' });
    if (parsed) return { issues: parsed.issues || [], summary: parsed.summary };
  }

  // Fallback: try direct JSON parse
  if (response.trim().startsWith('{') || response.trim().startsWith('[')) {
    const parsed = safeJSONParse(response, null, { logError: true, context: 'contradiction analysis fallback' });
    if (parsed) return { issues: parsed.issues || parsed || [], summary: parsed.summary };
  }

  return { issues: [], rawResponse: response };
}

export async function generateDynamicTests(providerId, model) {
  const soulContent = await getSoulForPrompt({ maxTokens: 8000 });

  if (!soulContent || soulContent.length < 100) {
    return { tests: [], error: 'Insufficient soul content to generate tests' };
  }

  const prompt = await buildPrompt('soul-test-generator', {
    soulContent
  }).catch(() => null);

  if (!prompt) {
    return { tests: [], error: 'Test generator prompt template not found' };
  }

  const provider = await getProviderById(providerId);
  if (!provider || !provider.enabled) {
    return { tests: [], error: 'Provider not found or disabled' };
  }

  const result = await callProviderAI(provider, model, prompt, { temperature: 0.7, max_tokens: 3000 });
  if (!result.error && result.text) {
    return parseGeneratedTests(result.text);
  }

  return { tests: [], error: result.error || 'Failed to generate tests' };
}

function parseGeneratedTests(response) {
  // Try to extract JSON from the response
  const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    const parsed = safeJSONParse(jsonMatch[1], null, { logError: true, context: 'generated tests' });
    if (parsed) return { tests: parsed.tests || parsed || [] };
  }

  // Fallback: try direct JSON parse
  if (response.trim().startsWith('{') || response.trim().startsWith('[')) {
    const parsed = safeJSONParse(response, null, { logError: true, context: 'generated tests fallback' });
    if (parsed) return { tests: parsed.tests || parsed || [] };
  }

  return { tests: [], rawResponse: response };
}

export async function analyzeWritingSamples(samples, providerId, model) {
  if (!samples || samples.length === 0) {
    return { error: 'No writing samples provided' };
  }

  const combinedSamples = samples.map((s, i) => `--- Sample ${i + 1} ---\n${s}`).join('\n\n');

  const prompt = await buildPrompt('soul-writing-analyzer', {
    samples: combinedSamples
  }).catch(() => null);

  if (!prompt) {
    return { error: 'Writing analyzer prompt template not found' };
  }

  const provider = await getProviderById(providerId);
  if (!provider || !provider.enabled) {
    return { error: 'Provider not found or disabled' };
  }

  const result = await callProviderAI(provider, model, prompt, { temperature: 0.5, max_tokens: 2000 });
  if (!result.error && result.text) {
    return parseWritingAnalysis(result.text);
  }

  return { error: result.error || 'Failed to analyze writing samples' };
}

function parseWritingAnalysis(response) {
  // Try to extract JSON
  const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    const parsed = safeJSONParse(jsonMatch[1], null, { logError: true, context: 'writing analysis' });
    if (parsed) {
      return {
        analysis: parsed.analysis || parsed,
        suggestedContent: parsed.suggestedContent || parsed.document || ''
      };
    }
  }

  // Extract markdown content for document if present
  const mdMatch = response.match(/```markdown\s*([\s\S]*?)\s*```/);
  const suggestedContent = mdMatch ? mdMatch[1] : '';

  return {
    analysis: { rawResponse: response },
    suggestedContent
  };
}

// =============================================================================
// TRAIT ANALYSIS & CONFIDENCE SCORING (Phase 1 & 2)
// =============================================================================

/**
 * Get all twin content for analysis (excludes behavioral tests)
 */
async function getAllTwinContent() {
  const meta = await loadMeta();
  const enabledDocs = meta.documents.filter(d => d.enabled && d.category !== 'behavioral');

  const contents = [];
  for (const doc of enabledDocs) {
    const filePath = join(DIGITAL_TWIN_DIR, doc.filename);
    if (existsSync(filePath)) {
      const content = await readFile(filePath, 'utf-8');
      contents.push(`## ${doc.title} (${doc.filename})\n\n${content}`);
    }
  }

  return contents.join('\n\n---\n\n');
}

/**
 * Get current traits from meta
 */
export async function getTraits() {
  const meta = await loadMeta();
  return meta.traits || null;
}

/**
 * Update traits manually (partial update)
 */
export async function updateTraits(updates) {
  const meta = await loadMeta();
  const currentTraits = meta.traits || {};

  const newTraits = {
    ...currentTraits,
    lastAnalyzed: new Date().toISOString(),
    analysisVersion: 'manual'
  };

  // Merge Big Five if provided
  if (updates.bigFive) {
    newTraits.bigFive = { ...currentTraits.bigFive, ...updates.bigFive };
  }

  // Replace values hierarchy if provided
  if (updates.valuesHierarchy) {
    newTraits.valuesHierarchy = updates.valuesHierarchy;
  }

  // Merge communication profile if provided
  if (updates.communicationProfile) {
    newTraits.communicationProfile = {
      ...currentTraits.communicationProfile,
      ...updates.communicationProfile
    };
  }

  meta.traits = newTraits;
  await saveMeta(meta);
  digitalTwinEvents.emit('traits:updated', newTraits);

  return newTraits;
}

/**
 * Analyze digital twin documents to extract personality traits
 */
export async function analyzeTraits(providerId, model, forceReanalyze = false) {
  const meta = await loadMeta();

  // Check if we have recent analysis and don't need to reanalyze
  if (!forceReanalyze && meta.traits?.lastAnalyzed) {
    const lastAnalyzed = new Date(meta.traits.lastAnalyzed);
    const hoursSince = (Date.now() - lastAnalyzed.getTime()) / (1000 * 60 * 60);
    if (hoursSince < 24) {
      return { traits: meta.traits, cached: true };
    }
  }

  const twinContent = await getAllTwinContent();
  if (!twinContent || twinContent.length < 100) {
    return { error: 'Not enough digital twin content to analyze. Add more documents first.' };
  }

  const prompt = await buildPrompt('twin-trait-extractor', {
    twinContent
  }).catch(() => null);

  if (!prompt) {
    return { error: 'Trait extractor prompt template not found' };
  }

  const provider = await getProviderById(providerId);
  if (!provider || !provider.enabled) {
    return { error: 'Provider not found or disabled' };
  }

  const result = await callProviderAI(provider, model, prompt, { temperature: 0.3, max_tokens: 3000 });
  if (result.error) {
    return { error: result.error };
  }

  const parsedTraits = parseTraitsResponse(result.text || '');
  if (parsedTraits.error) {
    return parsedTraits;
  }

  // Save to meta
  const traits = {
    bigFive: parsedTraits.bigFive,
    valuesHierarchy: parsedTraits.valuesHierarchy,
    communicationProfile: parsedTraits.communicationProfile,
    lastAnalyzed: new Date().toISOString(),
    analysisVersion: '1.0'
  };

  meta.traits = traits;
  await saveMeta(meta);
  digitalTwinEvents.emit('traits:analyzed', traits);

  // Recalculate confidence with updated traits
  await calculateConfidence();

  return { traits, analysisNotes: parsedTraits.analysisNotes };
}

function parseTraitsResponse(response) {
  const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
  const jsonStr = jsonMatch ? jsonMatch[1] : (response.trim().startsWith('{') ? response.trim() : null);

  if (!jsonStr) {
    return { error: 'Failed to parse traits response - no JSON found', rawResponse: response };
  }

  const parsed = safeJSONParse(jsonStr, null, { allowArray: false });
  if (!parsed) {
    return { error: 'Failed to parse traits response - invalid JSON', rawResponse: response };
  }

  return parsed;
}

/**
 * Get current confidence scores from meta
 */
export async function getConfidence() {
  const meta = await loadMeta();
  return meta.confidence || null;
}

/**
 * Calculate confidence scores for all personality dimensions
 */
export async function calculateConfidence(providerId, model) {
  const twinContent = await getAllTwinContent();
  const meta = await loadMeta();
  const currentTraits = meta.traits || {};

  // If no provider specified, do local calculation
  if (!providerId || !model) {
    return calculateLocalConfidence(twinContent, currentTraits, meta);
  }

  const prompt = await buildPrompt('twin-confidence-analyzer', {
    twinContent,
    currentTraits: JSON.stringify(currentTraits, null, 2)
  }).catch(() => null);

  if (!prompt) {
    // Fall back to local calculation
    return calculateLocalConfidence(twinContent, currentTraits, meta);
  }

  const provider = await getProviderById(providerId);
  if (!provider || !provider.enabled) {
    return calculateLocalConfidence(twinContent, currentTraits, meta);
  }

  const result = await callProviderAI(provider, model, prompt, { temperature: 0.3, max_tokens: 2000 });
  if (!result.error && result.text) {
    const parsed = parseConfidenceResponse(result.text);

    if (!parsed.error) {
      const confidence = {
        ...parsed,
        lastCalculated: new Date().toISOString()
      };

      meta.confidence = confidence;
      await saveMeta(meta);
      digitalTwinEvents.emit('confidence:calculated', confidence);

      return { confidence };
    }
  }

  // Fall back to local calculation
  return calculateLocalConfidence(twinContent, currentTraits, meta);
}

function parseConfidenceResponse(response) {
  const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    const parsed = safeJSONParse(jsonMatch[1], null, { logError: true, context: 'confidence response' });
    if (parsed) return parsed;
  }

  if (response.trim().startsWith('{')) {
    const parsed = safeJSONParse(response, null, { logError: true, context: 'confidence response fallback' });
    if (parsed) return parsed;
  }

  return { error: 'Failed to parse confidence response' };
}

/**
 * Calculate confidence locally without LLM (simpler heuristic-based)
 */
async function calculateLocalConfidence(twinContent, traits, meta) {
  const contentLower = twinContent.toLowerCase();
  const documents = await getDocuments();
  const enabledDocs = documents.filter(d => d.enabled && d.category !== 'behavioral');

  // Evidence counts based on keyword presence and document existence
  const dimensions = {
    openness: calculateDimensionConfidence(contentLower, ['curious', 'creative', 'explore', 'novel', 'experiment', 'learn'], traits?.bigFive?.O),
    conscientiousness: calculateDimensionConfidence(contentLower, ['organize', 'plan', 'discipline', 'routine', 'structure', 'systematic'], traits?.bigFive?.C),
    extraversion: calculateDimensionConfidence(contentLower, ['social', 'energy', 'people', 'outgoing', 'network', 'collaborate'], traits?.bigFive?.E),
    agreeableness: calculateDimensionConfidence(contentLower, ['empathy', 'cooperate', 'trust', 'kind', 'help', 'support'], traits?.bigFive?.A),
    neuroticism: calculateDimensionConfidence(contentLower, ['stress', 'anxiety', 'emotion', 'worry', 'calm', 'stable'], traits?.bigFive?.N),
    values: calculateDimensionConfidence(contentLower, ['value', 'principle', 'believe', 'important', 'priority', 'matter'], null, enabledDocs.some(d => d.filename.toLowerCase().includes('value'))),
    communication: calculateDimensionConfidence(contentLower, ['communicate', 'prefer', 'feedback', 'tone', 'style', 'write'], null, enabledDocs.some(d => d.filename.toLowerCase().includes('communi') || d.filename.toLowerCase().includes('writing'))),
    decision_making: calculateDimensionConfidence(contentLower, ['decision', 'choose', 'heuristic', 'rule', 'approach', 'consider'], null, enabledDocs.some(d => d.filename.toLowerCase().includes('decision'))),
    boundaries: calculateDimensionConfidence(contentLower, ['never', 'boundary', 'non-negotiable', 'refuse', 'limit', 'error'], null, enabledDocs.some(d => d.filename.toLowerCase().includes('non_negot') || d.filename.toLowerCase().includes('error'))),
    identity: calculateDimensionConfidence(contentLower, ['name', 'who i am', 'identity', 'role', 'purpose', 'mission'], null, enabledDocs.some(d => d.filename.toLowerCase().includes('soul') || d.category === 'core'))
  };

  // Calculate overall
  const scores = Object.values(dimensions);
  const overall = scores.reduce((a, b) => a + b, 0) / scores.length;

  // Generate gaps for low-confidence dimensions
  const gaps = generateGapRecommendations(dimensions);

  const confidence = {
    overall: Math.round(overall * 100) / 100,
    dimensions,
    gaps,
    lastCalculated: new Date().toISOString()
  };

  meta.confidence = confidence;
  await saveMeta(meta);
  digitalTwinEvents.emit('confidence:calculated', confidence);

  return { confidence, method: 'local' };
}

function calculateDimensionConfidence(content, keywords, existingScore, hasDocument = false) {
  let score = 0;

  // Keyword evidence (up to 0.5)
  const keywordHits = keywords.filter(k => content.includes(k)).length;
  score += Math.min(0.5, keywordHits * 0.1);

  // Document existence bonus (0.2)
  if (hasDocument) score += 0.2;

  // Existing trait score bonus (0.3)
  if (existingScore !== undefined && existingScore !== null) score += 0.3;

  return Math.min(1, Math.round(score * 100) / 100);
}

function generateGapRecommendations(dimensions) {
  const gaps = [];
  const threshold = 0.6;

  const dimensionConfig = {
    openness: {
      suggestedCategory: 'personality_assessments',
      questions: [
        'How do you typically react to new ideas or unconventional approaches?',
        'What topics or subjects consistently spark your curiosity?',
        'How comfortable are you with ambiguity and uncertainty?'
      ]
    },
    conscientiousness: {
      suggestedCategory: 'daily_routines',
      questions: [
        'Describe your typical approach to planning and organization.',
        'How do you handle deadlines and commitments?',
        'What systems or routines keep you productive?'
      ]
    },
    extraversion: {
      suggestedCategory: 'communication',
      questions: [
        'How do you prefer to spend your free time - with others or alone?',
        'In group settings, do you tend to lead conversations or observe?',
        'Where do you get your energy from - social interaction or solitude?'
      ]
    },
    agreeableness: {
      suggestedCategory: 'values',
      questions: [
        'How do you typically handle disagreements with others?',
        'What role does empathy play in your decision-making?',
        'How do you balance your needs with the needs of others?'
      ]
    },
    neuroticism: {
      suggestedCategory: 'personality_assessments',
      questions: [
        'How do you typically respond to unexpected setbacks or failures?',
        'What situations tend to make you feel anxious or stressed?',
        'How would others describe your emotional stability?'
      ]
    },
    values: {
      suggestedCategory: 'values',
      questions: [
        'What principles guide your most important decisions?',
        'Which values would you never compromise, even under pressure?',
        'What do you want to be known for?'
      ]
    },
    communication: {
      suggestedCategory: 'communication',
      questions: [
        'How do you prefer to receive feedback - direct or diplomatic?',
        'What communication styles do you find most effective?',
        'How would you describe your writing voice?'
      ]
    },
    decision_making: {
      suggestedCategory: 'decision_heuristics',
      questions: [
        'What mental shortcuts or rules of thumb guide your choices?',
        'How do you balance intuition vs. analysis in decisions?',
        'What factors do you prioritize when making important choices?'
      ]
    },
    boundaries: {
      suggestedCategory: 'non_negotiables',
      questions: [
        'What behaviors or requests would you always refuse?',
        'What principles are absolutely non-negotiable for you?',
        'What should your digital twin never do or say?'
      ]
    },
    identity: {
      suggestedCategory: 'core_memories',
      questions: [
        'How would you introduce yourself in one sentence?',
        'What makes you uniquely you?',
        'What is your core purpose or mission?'
      ]
    }
  };

  for (const [dimension, score] of Object.entries(dimensions)) {
    if (score < threshold) {
      const config = dimensionConfig[dimension];
      gaps.push({
        dimension,
        confidence: score,
        evidenceCount: Math.round(score * 5),
        requiredEvidence: 5,
        suggestedQuestions: config?.questions || [],
        suggestedCategory: config?.suggestedCategory || 'core_memories'
      });
    }
  }

  // Sort by confidence (lowest first)
  gaps.sort((a, b) => a.confidence - b.confidence);

  return gaps;
}

/**
 * Get gap recommendations (prioritized list of what to enrich)
 */
export async function getGapRecommendations() {
  const meta = await loadMeta();

  // If no confidence data, calculate it first
  if (!meta.confidence) {
    const result = await calculateConfidence();
    return result.confidence?.gaps || [];
  }

  return meta.confidence.gaps || [];
}

// =============================================================================
// EXTERNAL DATA IMPORT (Phase 4)
// =============================================================================

/**
 * Parse Goodreads CSV export
 * CSV columns: Book Id, Title, Author, Author l-f, Additional Authors, ISBN, ISBN13,
 * My Rating, Average Rating, Publisher, Binding, Number of Pages, Year Published,
 * Original Publication Year, Date Read, Date Added, Bookshelves, Bookshelves with positions,
 * Exclusive Shelf, My Review, Spoiler, Private Notes, Read Count, Owned Copies
 */
function parseGoodreadsCSV(csvData) {
  const lines = csvData.split('\n');
  if (lines.length < 2) return [];

  // Parse header to find column indices
  const header = parseCSVLine(lines[0]);
  const titleIdx = header.findIndex(h => h.toLowerCase() === 'title');
  const authorIdx = header.findIndex(h => h.toLowerCase() === 'author');
  const ratingIdx = header.findIndex(h => h.toLowerCase() === 'my rating');
  const dateReadIdx = header.findIndex(h => h.toLowerCase() === 'date read');
  const shelvesIdx = header.findIndex(h => h.toLowerCase() === 'bookshelves');
  const reviewIdx = header.findIndex(h => h.toLowerCase() === 'my review');

  const books = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = parseCSVLine(lines[i]);

    const rating = ratingIdx >= 0 ? parseInt(cols[ratingIdx], 10) : 0;
    // Only include books that were actually read (have a rating > 0 or date read)
    if (rating > 0 || (dateReadIdx >= 0 && cols[dateReadIdx])) {
      books.push({
        title: cols[titleIdx] || '',
        author: cols[authorIdx] || '',
        rating: rating || undefined,
        dateRead: dateReadIdx >= 0 ? cols[dateReadIdx] : undefined,
        shelves: shelvesIdx >= 0 && cols[shelvesIdx] ? cols[shelvesIdx].split(',').map(s => s.trim()) : [],
        review: reviewIdx >= 0 ? cols[reviewIdx] : undefined
      });
    }
  }

  return books;
}

/**
 * Parse a CSV line handling quoted fields
 */
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());

  return result;
}

/**
 * Parse Spotify extended streaming history JSON
 * Spotify exports: endTime, artistName, trackName, msPlayed
 */
function parseSpotifyJSON(jsonData) {
  const data = safeJSONParse(jsonData, null, { logError: true, context: 'Spotify JSON import' });
  if (!data) return [];

  // Handle both array format and object with streams array
  const streams = Array.isArray(data) ? data : (data.streams || data);
  if (!Array.isArray(streams)) return [];

  // Aggregate by artist
  const artistCounts = new Map();
  const trackCounts = new Map();

  for (const entry of streams) {
    const artist = entry.artistName || entry.master_metadata_album_artist_name;
    const track = entry.trackName || entry.master_metadata_track_name;
    const msPlayed = entry.msPlayed || entry.ms_played || 0;

    if (artist) {
      const existing = artistCounts.get(artist) || { playCount: 0, msPlayed: 0 };
      artistCounts.set(artist, {
        playCount: existing.playCount + 1,
        msPlayed: existing.msPlayed + msPlayed
      });
    }

    if (track && artist) {
      const key = `${track}|||${artist}`;
      const existing = trackCounts.get(key) || { playCount: 0, msPlayed: 0 };
      trackCounts.set(key, {
        trackName: track,
        artistName: artist,
        playCount: existing.playCount + 1,
        msPlayed: existing.msPlayed + msPlayed
      });
    }
  }

  // Return top artists and tracks
  const topArtists = Array.from(artistCounts.entries())
    .map(([name, data]) => ({ artistName: name, ...data }))
    .sort((a, b) => b.msPlayed - a.msPlayed)
    .slice(0, 50);

  const topTracks = Array.from(trackCounts.values())
    .sort((a, b) => b.playCount - a.playCount)
    .slice(0, 50);

  return { artists: topArtists, tracks: topTracks };
}

/**
 * Parse Letterboxd CSV export
 */
function parseLetterboxdCSV(csvData) {
  const lines = csvData.split('\n');
  if (lines.length < 2) return [];

  const header = parseCSVLine(lines[0]);
  const nameIdx = header.findIndex(h => h.toLowerCase().includes('name') || h.toLowerCase() === 'title');
  const yearIdx = header.findIndex(h => h.toLowerCase() === 'year');
  const ratingIdx = header.findIndex(h => h.toLowerCase() === 'rating');
  const dateIdx = header.findIndex(h => h.toLowerCase().includes('watched'));
  const reviewIdx = header.findIndex(h => h.toLowerCase() === 'review');
  const tagsIdx = header.findIndex(h => h.toLowerCase() === 'tags');

  const films = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = parseCSVLine(lines[i]);

    films.push({
      title: cols[nameIdx] || cols[0] || '',
      year: yearIdx >= 0 && cols[yearIdx] ? parseInt(cols[yearIdx], 10) : undefined,
      rating: ratingIdx >= 0 && cols[ratingIdx] ? parseFloat(cols[ratingIdx]) : undefined,
      watchedDate: dateIdx >= 0 ? cols[dateIdx] : undefined,
      review: reviewIdx >= 0 ? cols[reviewIdx] : undefined,
      tags: tagsIdx >= 0 && cols[tagsIdx] ? cols[tagsIdx].split(',').map(t => t.trim()) : []
    });
  }

  return films.filter(f => f.title);
}

/**
 * Parse iCal/ICS calendar file
 */
function parseICalData(icsData) {
  const events = [];
  const eventBlocks = icsData.split('BEGIN:VEVENT');

  for (let i = 1; i < eventBlocks.length; i++) {
    const block = eventBlocks[i].split('END:VEVENT')[0];
    const event = {};

    const summaryMatch = block.match(/SUMMARY[^:]*:(.+?)(?:\r?\n(?![^\r\n])|\r?\n[A-Z])/s);
    if (summaryMatch) event.summary = summaryMatch[1].replace(/\r?\n\s/g, '').trim();

    const startMatch = block.match(/DTSTART[^:]*:(\d{8}T?\d{0,6})/);
    if (startMatch) event.start = startMatch[1];

    const endMatch = block.match(/DTEND[^:]*:(\d{8}T?\d{0,6})/);
    if (endMatch) event.end = endMatch[1];

    const rruleMatch = block.match(/RRULE:/);
    event.recurring = !!rruleMatch;

    const categoriesMatch = block.match(/CATEGORIES[^:]*:(.+?)(?:\r?\n[A-Z])/s);
    if (categoriesMatch) {
      event.categories = categoriesMatch[1].split(',').map(c => c.trim());
    }

    if (event.summary) {
      events.push(event);
    }
  }

  return events;
}

/**
 * Analyze imported data and extract personality insights
 */
export async function analyzeImportedData(source, rawData, providerId, model) {
  let parsedData;
  let dataDescription;

  // Parse based on source
  switch (source) {
    case 'goodreads': {
      parsedData = parseGoodreadsCSV(rawData);
      if (parsedData.length === 0) {
        return { error: 'No books found in Goodreads export. Make sure you exported your library.' };
      }
      const topRated = parsedData.filter(b => b.rating >= 4).slice(0, 20);
      const authors = [...new Set(parsedData.map(b => b.author).filter(Boolean))].slice(0, 20);
      const shelves = [...new Set(parsedData.flatMap(b => b.shelves || []))].slice(0, 15);
      dataDescription = `Reading History (${parsedData.length} books):\n` +
        `Top-rated books: ${topRated.map(b => `"${b.title}" by ${b.author} (${b.rating}/5)`).join(', ')}\n` +
        `Favorite authors: ${authors.join(', ')}\n` +
        `Shelves/genres: ${shelves.join(', ')}\n` +
        `Sample reviews: ${parsedData.filter(b => b.review).slice(0, 3).map(b => `"${b.title}": ${b.review?.substring(0, 200)}...`).join('\n')}`;
      break;
    }

    case 'spotify': {
      parsedData = parseSpotifyJSON(rawData);
      if (!parsedData.artists || parsedData.artists.length === 0) {
        return { error: 'No listening data found in Spotify export.' };
      }
      const topArtists = parsedData.artists.slice(0, 15);
      const topTracks = parsedData.tracks?.slice(0, 15) || [];
      const totalHours = Math.round(topArtists.reduce((sum, a) => sum + a.msPlayed, 0) / 3600000);
      dataDescription = `Listening History (${totalHours} hours tracked):\n` +
        `Top artists: ${topArtists.map(a => `${a.artistName} (${Math.round(a.msPlayed / 60000)} min)`).join(', ')}\n` +
        `Top tracks: ${topTracks.map(t => `"${t.trackName}" by ${t.artistName}`).join(', ')}`;
      break;
    }

    case 'letterboxd': {
      parsedData = parseLetterboxdCSV(rawData);
      if (parsedData.length === 0) {
        return { error: 'No films found in Letterboxd export.' };
      }
      const topRated = parsedData.filter(f => f.rating >= 4).slice(0, 20);
      const tags = [...new Set(parsedData.flatMap(f => f.tags || []))].slice(0, 15);
      dataDescription = `Film History (${parsedData.length} films):\n` +
        `Top-rated films: ${topRated.map(f => `"${f.title}" (${f.year}) - ${f.rating}/5`).join(', ')}\n` +
        `Tags/themes: ${tags.join(', ')}\n` +
        `Sample reviews: ${parsedData.filter(f => f.review).slice(0, 3).map(f => `"${f.title}": ${f.review?.substring(0, 200)}...`).join('\n')}`;
      break;
    }

    case 'ical': {
      parsedData = parseICalData(rawData);
      if (parsedData.length === 0) {
        return { error: 'No events found in calendar export.' };
      }
      const recurring = parsedData.filter(e => e.recurring);
      const categories = [...new Set(parsedData.flatMap(e => e.categories || []))];
      const eventTypes = {};
      parsedData.forEach(e => {
        const type = categorizeEvent(e.summary);
        eventTypes[type] = (eventTypes[type] || 0) + 1;
      });
      dataDescription = `Calendar Analysis (${parsedData.length} events, ${recurring.length} recurring):\n` +
        `Event types: ${Object.entries(eventTypes).map(([k, v]) => `${k}: ${v}`).join(', ')}\n` +
        `Categories: ${categories.join(', ')}\n` +
        `Recurring commitments: ${recurring.slice(0, 10).map(e => e.summary).join(', ')}`;
      break;
    }

    default:
      return { error: `Unknown import source: ${source}` };
  }

  // Build analysis prompt
  const prompt = await buildPrompt('twin-import-analyzer', {
    source,
    dataDescription,
    itemCount: Array.isArray(parsedData) ? parsedData.length : (parsedData.artists?.length || 0)
  }).catch(() => null);

  if (!prompt) {
    // Fallback to inline prompt
    const fallbackPrompt = buildImportAnalyzerPrompt(source, dataDescription);
    return analyzeWithPrompt(fallbackPrompt, providerId, model, source, parsedData);
  }

  return analyzeWithPrompt(prompt, providerId, model, source, parsedData);
}

/**
 * Categorize calendar event by its summary
 */
function categorizeEvent(summary) {
  const lower = (summary || '').toLowerCase();
  if (lower.includes('meeting') || lower.includes('call') || lower.includes('sync')) return 'work';
  if (lower.includes('gym') || lower.includes('workout') || lower.includes('run') || lower.includes('yoga')) return 'fitness';
  if (lower.includes('doctor') || lower.includes('dentist') || lower.includes('appointment')) return 'health';
  if (lower.includes('dinner') || lower.includes('lunch') || lower.includes('coffee')) return 'social';
  if (lower.includes('class') || lower.includes('lesson') || lower.includes('course')) return 'learning';
  if (lower.includes('travel') || lower.includes('flight') || lower.includes('trip')) return 'travel';
  return 'other';
}

/**
 * Build fallback prompt for import analysis
 */
function buildImportAnalyzerPrompt(source, dataDescription) {
  const sourceLabels = {
    goodreads: 'reading history',
    spotify: 'music listening history',
    letterboxd: 'film watching history',
    ical: 'calendar/schedule patterns'
  };

  return `Analyze this ${sourceLabels[source] || source} data to understand the person's personality, values, and interests.

## Data
${dataDescription}

## Analysis Instructions
Based on this data, infer:

1. **Personality Traits (Big Five)**: What does their ${sourceLabels[source]} suggest about their Openness, Conscientiousness, Extraversion, Agreeableness, and Neuroticism? Provide estimates from 0.0 to 1.0.

2. **Values**: What values seem important to this person based on their choices?

3. **Interests & Themes**: What topics, genres, or themes do they gravitate toward?

4. **Patterns**: Any notable patterns in their behavior (e.g., variety vs. consistency, niche vs. mainstream)?

5. **Suggested Document Content**: Write a short markdown document summarizing key insights about their ${sourceLabels[source]} preferences.

## Output Format
Respond with JSON only:

\`\`\`json
{
  "insights": {
    "patterns": ["pattern 1", "pattern 2"],
    "preferences": ["preference 1", "preference 2"],
    "personalityInferences": {
      "bigFive": { "O": 0.7, "C": 0.6, "E": 0.5, "A": 0.6, "N": 0.4 },
      "values": ["value1", "value2"],
      "interests": ["interest1", "interest2"]
    }
  },
  "suggestedDocuments": [
    {
      "filename": "READING_PROFILE.md",
      "title": "Reading Profile",
      "category": "entertainment",
      "content": "# Reading Profile\\n\\nMarkdown content here..."
    }
  ],
  "rawSummary": "2-3 sentence summary of what this data reveals about the person"
}
\`\`\``;
}

/**
 * Send prompt to AI and parse response
 */
async function analyzeWithPrompt(prompt, providerId, model, source, parsedData) {
  const provider = await getProviderById(providerId);
  if (!provider || !provider.enabled) {
    return { error: 'Provider not found or disabled' };
  }

  const result = await callProviderAI(provider, model, prompt, { temperature: 0.4, max_tokens: 3000 });
  if (!result.error && result.text) {
    return parseImportAnalysisResponse(result.text, source, parsedData);
  }

  return { error: result.error || 'Provider request failed' };
}

/**
 * Parse AI response for import analysis
 */
function parseImportAnalysisResponse(response, source, parsedData) {
  const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    const parsed = safeJSONParse(jsonMatch[1], null, { logError: true, context: 'import analysis' });
    if (parsed) {
      return {
        source,
        itemCount: Array.isArray(parsedData) ? parsedData.length : (parsedData.artists?.length || 0),
        ...parsed
      };
    }
  }

  if (response.trim().startsWith('{')) {
    const parsed = safeJSONParse(response, null, { logError: true, context: 'import analysis fallback' });
    if (parsed) {
      return {
        source,
        itemCount: Array.isArray(parsedData) ? parsedData.length : (parsedData.artists?.length || 0),
        ...parsed
      };
    }
  }

  return {
    source,
    itemCount: Array.isArray(parsedData) ? parsedData.length : (parsedData.artists?.length || 0),
    insights: { patterns: [], preferences: [] },
    rawSummary: response
  };
}

/**
 * Save imported analysis as a document
 */
export async function saveImportAsDocument(source, suggestedDoc) {
  const { filename, title, category, content } = suggestedDoc;

  // Check if document already exists
  const meta = await loadMeta();
  const existingDoc = meta.documents.find(d => d.filename === filename);

  if (existingDoc) {
    // Update existing document
    return updateDocument(existingDoc.id, { content, title });
  }

  // Create new document
  return createDocument({
    filename,
    title,
    category,
    content,
    enabled: true,
    priority: 5
  });
}

// =============================================================================
// ASSESSMENT ANALYZER
// =============================================================================

/**
 * Analyze a pasted personality assessment without session management.
 * Extracts traits, creates/updates documents, and returns gap recommendations.
 */
export async function analyzeAssessment(content, providerId, model) {
  console.log(`🧪 [${now()}] Assessment analysis: provider=${providerId}, model=${model}, content=${content.length} chars`);

  // 1. Load twin context
  const twinContent = await getAllTwinContent();
  const meta = await loadMeta();
  const currentTraits = meta.traits || {};
  const confidenceBefore = meta.confidence?.overall || 0;

  // 2. Build analysis prompt
  const analysisPrompt = await buildPrompt('twin-interview-analyze', {
    twinContent: twinContent || 'No existing twin documents yet.',
    currentTraits: JSON.stringify(currentTraits, null, 2) || '{}',
    pastedContent: content
  }).catch(() => null);

  if (!analysisPrompt) {
    return { error: 'Analysis prompt template not found' };
  }

  const provider = await getProviderById(providerId);
  if (!provider || !provider.enabled) {
    return { error: 'Provider not found or disabled' };
  }

  // 3. Call AI for analysis
  console.log(`🧪 [${now()}] Calling ${provider.name} (${model}), prompt=${analysisPrompt.length} chars`);
  const aiResponse = await callProviderAI(provider, model, analysisPrompt, { temperature: 0.3, max_tokens: 4000 });

  if (aiResponse.error) {
    return { error: aiResponse.error };
  }

  const parsed = parseTraitsResponse(aiResponse.text);
  if (parsed.error) {
    return { error: parsed.error };
  }

  // 4. Apply trait updates
  const traitUpdates = {};
  if (parsed.bigFive) traitUpdates.bigFive = parsed.bigFive;
  if (parsed.valuesHierarchy) traitUpdates.valuesHierarchy = parsed.valuesHierarchy;
  if (parsed.communicationProfile) traitUpdates.communicationProfile = parsed.communicationProfile;

  if (Object.keys(traitUpdates).length > 0) {
    await updateTraits(traitUpdates);
  }

  // 5. Create/update documents from suggestions
  const docsCreated = [];
  const docsUpdated = [];
  for (const doc of (parsed.suggestedDocuments || [])) {
    if (!doc.filename || !doc.content) continue;
    const currentMeta = await loadMeta();
    const existsBefore = currentMeta.documents.some(d => d.filename === doc.filename);
    const result = await saveImportAsDocument('interview', {
      filename: doc.filename,
      title: doc.title || doc.filename.replace('.md', ''),
      category: doc.category || 'enrichment',
      content: doc.content
    });
    if (result) {
      (existsBefore ? docsUpdated : docsCreated).push(doc.filename);
    }
  }

  // 6. Recalculate confidence with updated content and traits
  const confidenceResult = await calculateConfidence();
  const confidenceAfter = confidenceResult.confidence?.overall || confidenceBefore;

  // 7. Get gap recommendations
  const gaps = await getGapRecommendations();

  const analysisResult = {
    traitsUpdated: traitUpdates,
    documentsCreated: docsCreated,
    documentsUpdated: docsUpdated,
    newDimensions: parsed.newDimensions || [],
    confidenceDelta: { before: confidenceBefore, after: confidenceAfter },
    summary: parsed.summary || 'Analysis complete. Twin profile updated.'
  };

  digitalTwinEvents.emit('interview:analyzed', { analysisResult });
  console.log(`🧪 [${now()}] Assessment complete: ${docsCreated.length} created, ${docsUpdated.length} updated, ${Object.keys(traitUpdates).length} trait categories`);

  return { analysisResult, gaps };
}

/**
 * Get list of supported import sources
 */
export function getImportSources() {
  return [
    {
      id: 'goodreads',
      name: 'Goodreads',
      description: 'Import your reading history to analyze literary preferences and themes',
      format: 'CSV',
      instructions: 'Go to My Books > Import/Export > Export Library. Download the CSV file.'
    },
    {
      id: 'spotify',
      name: 'Spotify',
      description: 'Import listening history to analyze music preferences and emotional patterns',
      format: 'JSON',
      instructions: 'Go to Account > Privacy Settings > Download your data. Request "Extended streaming history". Extract the JSON files.'
    },
    {
      id: 'letterboxd',
      name: 'Letterboxd',
      description: 'Import film diary to analyze viewing preferences and aesthetic tastes',
      format: 'CSV',
      instructions: 'Go to Settings > Import & Export > Export Your Data. Download the diary.csv or films.csv.'
    },
    {
      id: 'ical',
      name: 'Calendar (iCal)',
      description: 'Import calendar to analyze routine patterns and time allocation',
      format: 'ICS',
      instructions: 'Export your calendar as .ics file from Google Calendar, Apple Calendar, or Outlook.'
    }
  ];
}
