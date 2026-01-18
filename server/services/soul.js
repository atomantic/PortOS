/**
 * Soul Service
 *
 * Core business logic for the Soul feature:
 * - Document CRUD (manage soul markdown files)
 * - Behavioral testing against LLMs
 * - Enrichment questionnaire system
 * - Export for external LLM use
 * - CoS integration (soul context injection)
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
  soulMetaSchema,
  documentMetaSchema,
  testHistoryEntrySchema
} from '../lib/soulValidation.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SOUL_DIR = join(__dirname, '../../data/soul');
const META_FILE = join(SOUL_DIR, 'meta.json');

// Event emitter for soul data changes
export const soulEvents = new EventEmitter();

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
  if (!existsSync(SOUL_DIR)) {
    await mkdir(SOUL_DIR, { recursive: true });
    console.log(`🧬 Created soul data directory: ${SOUL_DIR}`);
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
  const validated = soulMetaSchema.safeParse(parsed);

  cache.meta.data = validated.success ? validated.data : { ...DEFAULT_META, ...parsed };
  cache.meta.timestamp = Date.now();
  return cache.meta.data;
}

async function buildInitialMeta() {
  const meta = { ...DEFAULT_META };

  const files = await readdir(SOUL_DIR).catch(() => []);
  const mdFiles = files.filter(f => f.endsWith('.md'));

  for (const file of mdFiles) {
    const content = await readFile(join(SOUL_DIR, file), 'utf-8').catch(() => '');
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
    const filePath = join(SOUL_DIR, doc.filename);
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

  const filePath = join(SOUL_DIR, docMeta.filename);
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
  const filePath = join(SOUL_DIR, data.filename);

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
  const filePath = join(SOUL_DIR, docMeta.filename);

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
  const filePath = join(SOUL_DIR, docMeta.filename);

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

  const testFile = join(SOUL_DIR, 'BEHAVIORAL_TEST_SUITE.md');
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
    sampleQuestions: config.questions.length
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
  const targetPath = join(SOUL_DIR, config.targetDoc);
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

export async function exportSoul(format, documentIds = null, includeDisabled = false) {
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
    const filePath = join(SOUL_DIR, doc.filename);
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

export async function getSoulForPrompt(options = {}) {
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
    const filePath = join(SOUL_DIR, doc.filename);
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

// =============================================================================
// STATUS & SUMMARY
// =============================================================================

export async function getSoulStatus() {
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

// =============================================================================
// VALIDATION & ANALYSIS
// =============================================================================

// Required sections for a complete soul
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
    const filePath = join(SOUL_DIR, doc.filename);
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
    const filePath = join(SOUL_DIR, doc.filename);
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
