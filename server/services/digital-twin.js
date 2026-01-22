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
      'What principle would you never compromise, even at personal cost?',
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
  const parsed = JSON.parse(content);
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
      testId: parseInt(match[1]),
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

  // Build the prompt with soul context as system prompt
  const systemPrompt = `You are embodying the following identity. Respond as this person would, based on the soul document below:\n\n${soulContext}`;

  let response = '';

  if (provider.type === 'api') {
    const headers = { 'Content-Type': 'application/json' };
    if (provider.apiKey) {
      headers['Authorization'] = `Bearer ${provider.apiKey}`;
    }

    const apiResponse = await fetch(`${provider.endpoint}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: test.prompt }
        ],
        temperature: 0.7,
        max_tokens: 1000
      })
    });

    if (!apiResponse.ok) {
      throw new Error(`API error: ${apiResponse.status}`);
    }

    const data = await apiResponse.json();
    response = data.choices?.[0]?.message?.content || '';
  } else {
    // For CLI providers, combine system prompt with user prompt
    const { spawn } = await import('child_process');
    const combinedPrompt = `${systemPrompt}\n\nUser: ${test.prompt}`;

    response = await new Promise((resolve, reject) => {
      const args = [...(provider.args || []), combinedPrompt];
      let output = '';

      const child = spawn(provider.command, args, {
        env: { ...process.env, ...provider.envVars },
        shell: false
      });

      child.stdout.on('data', (data) => { output += data.toString(); });
      child.stderr.on('data', (data) => { output += data.toString(); });
      child.on('close', () => resolve(output));
      child.on('error', reject);

      setTimeout(() => { child.kill(); reject(new Error('Timeout')); }, 60000);
    });
  }

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

  if (provider.type === 'api') {
    const headers = { 'Content-Type': 'application/json' };
    if (provider.apiKey) {
      headers['Authorization'] = `Bearer ${provider.apiKey}`;
    }

    const apiResponse = await fetch(`${provider.endpoint}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 500
      })
    });

    if (apiResponse.ok) {
      const data = await apiResponse.json();
      const scoringResponse = data.choices?.[0]?.message?.content || '';
      return parseScoreResponse(scoringResponse);
    }
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

export async function generateEnrichmentQuestion(category, providerOverride, modelOverride) {
  const config = ENRICHMENT_CATEGORIES[category];
  if (!config) {
    throw new Error(`Unknown enrichment category: ${category}`);
  }

  const meta = await loadMeta();
  const questionsAnswered = meta.enrichment.questionsAnswered?.[category] || 0;

  // Use predefined questions first
  if (questionsAnswered < config.questions.length) {
    return {
      questionId: generateId(),
      category,
      question: config.questions[questionsAnswered],
      isGenerated: false,
      questionNumber: questionsAnswered + 1,
      totalQuestions: config.questions.length
    };
  }

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
    return {
      questionId: generateId(),
      category,
      question: config.questions[0], // Fallback to first question
      isGenerated: false,
      questionNumber: questionsAnswered + 1,
      totalQuestions: config.questions.length
    };
  }

  const provider = providerOverride
    ? await getProviderById(providerOverride)
    : await getActiveProvider();

  if (!provider) {
    throw new Error('No AI provider available');
  }

  const model = modelOverride || provider.defaultModel;

  let question = config.questions[0]; // Fallback

  if (provider.type === 'api') {
    const headers = { 'Content-Type': 'application/json' };
    if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`;

    const response = await fetch(`${provider.endpoint}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.8,
        max_tokens: 200
      })
    });

    if (response.ok) {
      const data = await response.json();
      question = data.choices?.[0]?.message?.content?.trim() || question;
    }
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

export async function processEnrichmentAnswer(data) {
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

    if (prompt && provider.type === 'api') {
      const headers = { 'Content-Type': 'application/json' };
      if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`;

      const response = await fetch(`${provider.endpoint}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: providerOverride || provider.defaultModel,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens: 500
        })
      });

      if (response.ok) {
        const respData = await response.json();
        formattedContent = respData.choices?.[0]?.message?.content?.trim() || formattedContent;
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

  await saveMeta(meta);

  console.log(`🧬 Enrichment answer processed for ${category}`);

  return {
    category,
    targetDoc: config.targetDoc,
    contentAdded: formattedContent
  };
}

export async function getEnrichmentProgress() {
  const meta = await loadMeta();
  const categories = Object.keys(ENRICHMENT_CATEGORIES);

  const progress = {};
  for (const cat of categories) {
    const answered = meta.enrichment.questionsAnswered?.[cat] || 0;
    const baseQuestions = ENRICHMENT_CATEGORIES[cat].questions.length;
    progress[cat] = {
      answered,
      baseQuestions,
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

  if (provider.type !== 'api') {
    throw new Error('List analysis requires an API provider');
  }

  const headers = { 'Content-Type': 'application/json' };
  if (provider.apiKey) {
    headers['Authorization'] = `Bearer ${provider.apiKey}`;
  }

  const response = await fetch(`${provider.endpoint}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 3000
    })
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  const data = await response.json();
  const responseText = data.choices?.[0]?.message?.content || '';

  // Parse the JSON response
  const jsonMatch = responseText.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    const parsed = JSON.parse(jsonMatch[1]);
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

  if (provider.type === 'api') {
    const headers = { 'Content-Type': 'application/json' };
    if (provider.apiKey) {
      headers['Authorization'] = `Bearer ${provider.apiKey}`;
    }

    const response = await fetch(`${provider.endpoint}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 2000
      })
    });

    if (response.ok) {
      const data = await response.json();
      const responseText = data.choices?.[0]?.message?.content || '';
      return parseContradictionResponse(responseText);
    }
  }

  return { issues: [], error: 'Failed to analyze contradictions' };
}

function parseContradictionResponse(response) {
  // Try to extract JSON from the response
  const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    const parsed = JSON.parse(jsonMatch[1]);
    return { issues: parsed.issues || [], summary: parsed.summary };
  }

  // Fallback: try direct JSON parse
  if (response.trim().startsWith('{') || response.trim().startsWith('[')) {
    const parsed = JSON.parse(response);
    return { issues: parsed.issues || parsed || [], summary: parsed.summary };
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

  if (provider.type === 'api') {
    const headers = { 'Content-Type': 'application/json' };
    if (provider.apiKey) {
      headers['Authorization'] = `Bearer ${provider.apiKey}`;
    }

    const response = await fetch(`${provider.endpoint}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 3000
      })
    });

    if (response.ok) {
      const data = await response.json();
      const responseText = data.choices?.[0]?.message?.content || '';
      return parseGeneratedTests(responseText);
    }
  }

  return { tests: [], error: 'Failed to generate tests' };
}

function parseGeneratedTests(response) {
  // Try to extract JSON from the response
  const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    const parsed = JSON.parse(jsonMatch[1]);
    return { tests: parsed.tests || parsed || [] };
  }

  // Fallback: try direct JSON parse
  if (response.trim().startsWith('{') || response.trim().startsWith('[')) {
    const parsed = JSON.parse(response);
    return { tests: parsed.tests || parsed || [] };
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

  if (provider.type === 'api') {
    const headers = { 'Content-Type': 'application/json' };
    if (provider.apiKey) {
      headers['Authorization'] = `Bearer ${provider.apiKey}`;
    }

    const response = await fetch(`${provider.endpoint}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.5,
        max_tokens: 2000
      })
    });

    if (response.ok) {
      const data = await response.json();
      const responseText = data.choices?.[0]?.message?.content || '';
      return parseWritingAnalysis(responseText);
    }
  }

  return { error: 'Failed to analyze writing samples' };
}

function parseWritingAnalysis(response) {
  // Try to extract JSON
  const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    const parsed = JSON.parse(jsonMatch[1]);
    return {
      analysis: parsed.analysis || parsed,
      suggestedContent: parsed.suggestedContent || parsed.document || ''
    };
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

  if (provider.type === 'api') {
    const headers = { 'Content-Type': 'application/json' };
    if (provider.apiKey) {
      headers['Authorization'] = `Bearer ${provider.apiKey}`;
    }

    const response = await fetch(`${provider.endpoint}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 3000
      })
    });

    if (response.ok) {
      const data = await response.json();
      const responseText = data.choices?.[0]?.message?.content || '';
      const parsedTraits = parseTraitsResponse(responseText);

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

      return { traits, analysisNotes: parsedTraits.analysisNotes };
    }

    return { error: `Provider request failed: ${response.status}` };
  }

  return { error: 'Provider type not supported for trait analysis' };
}

function parseTraitsResponse(response) {
  const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    const parsed = JSON.parse(jsonMatch[1]);
    return parsed;
  }

  if (response.trim().startsWith('{')) {
    return JSON.parse(response);
  }

  return { error: 'Failed to parse traits response', rawResponse: response };
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

  if (provider.type === 'api') {
    const headers = { 'Content-Type': 'application/json' };
    if (provider.apiKey) {
      headers['Authorization'] = `Bearer ${provider.apiKey}`;
    }

    const response = await fetch(`${provider.endpoint}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 2000
      })
    });

    if (response.ok) {
      const data = await response.json();
      const responseText = data.choices?.[0]?.message?.content || '';
      const parsed = parseConfidenceResponse(responseText);

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
  }

  // Fall back to local calculation
  return calculateLocalConfidence(twinContent, currentTraits, meta);
}

function parseConfidenceResponse(response) {
  const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    return JSON.parse(jsonMatch[1]);
  }

  if (response.trim().startsWith('{')) {
    return JSON.parse(response);
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
