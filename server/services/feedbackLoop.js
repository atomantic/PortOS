/**
 * Behavioral Feedback Loop Service (M34 P3)
 *
 * Captures "sounds like me" / "doesn't sound like me" validations on
 * AI-generated content (test responses, taste summaries, enrichment output).
 * Tracks feedback patterns and adjusts document weights for confidence scoring.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { safeJSONParse } from '../lib/fileUtils.js';
import { digitalTwinEvents } from './digital-twin.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DIGITAL_TWIN_DIR = join(__dirname, '../../data/digital-twin');
const FEEDBACK_FILE = join(DIGITAL_TWIN_DIR, 'feedback.json');

function now() {
  return new Date().toISOString();
}

// =============================================================================
// DATA ACCESS
// =============================================================================

let feedbackCache = null;

async function loadFeedback() {
  if (feedbackCache) return feedbackCache;

  const defaultData = {
    version: '1.0.0',
    entries: [],
    stats: { totalFeedback: 0, soundsLikeMe: 0, doesntSoundLikeMe: 0 },
    documentWeightAdjustments: {},
    lastCalculatedAt: null
  };

  if (!existsSync(FEEDBACK_FILE)) {
    await saveFeedback(defaultData);
    return defaultData;
  }

  const raw = await readFile(FEEDBACK_FILE, 'utf-8');
  feedbackCache = safeJSONParse(raw, defaultData);
  return feedbackCache;
}

async function saveFeedback(data) {
  if (!existsSync(DIGITAL_TWIN_DIR)) {
    await mkdir(DIGITAL_TWIN_DIR, { recursive: true });
  }
  data.updatedAt = now();
  await writeFile(FEEDBACK_FILE, JSON.stringify(data, null, 2));
  feedbackCache = data;
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Submit a "sounds like me" or "doesn't sound like me" feedback entry.
 *
 * @param {Object} params
 * @param {string} params.contentType - 'test_response' | 'taste_summary' | 'enrichment' | 'export'
 * @param {string} params.validation - 'sounds_like_me' | 'not_quite' | 'doesnt_sound_like_me'
 * @param {string} params.contentSnippet - The AI-generated text being validated (first 500 chars)
 * @param {string} [params.context] - Additional context (test name, section id, etc.)
 * @param {string} [params.providerId] - Which provider generated the content
 * @param {string} [params.model] - Which model generated the content
 * @param {string[]} [params.documentsUsed] - Which twin documents influenced the response
 */
export async function submitFeedback({ contentType, validation, contentSnippet, context, providerId, model, documentsUsed }) {
  const data = await loadFeedback();

  const entry = {
    id: uuidv4(),
    contentType,
    validation,
    contentSnippet: (contentSnippet || '').slice(0, 500),
    context: context || null,
    providerId: providerId || null,
    model: model || null,
    documentsUsed: documentsUsed || [],
    createdAt: now()
  };

  data.entries.push(entry);

  // Update running stats
  data.stats.totalFeedback++;
  if (validation === 'sounds_like_me') data.stats.soundsLikeMe++;
  else if (validation === 'doesnt_sound_like_me') data.stats.doesntSoundLikeMe++;

  // Keep last 500 entries to prevent unbounded growth
  if (data.entries.length > 500) {
    data.entries = data.entries.slice(-500);
  }

  await saveFeedback(data);

  digitalTwinEvents.emit('feedback:submitted', entry);
  console.log(`🔄 Feedback submitted: ${validation} on ${contentType} (${data.stats.totalFeedback} total)`);

  return entry;
}

/**
 * Get feedback statistics and analysis.
 */
export async function getFeedbackStats() {
  const data = await loadFeedback();
  const entries = data.entries;

  if (entries.length === 0) {
    return {
      totalFeedback: 0,
      validationRate: null,
      byContentType: {},
      byValidation: {},
      recentTrend: null,
      documentWeightAdjustments: {},
      lastCalculatedAt: data.lastCalculatedAt
    };
  }

  // Aggregate by content type
  const byContentType = {};
  for (const e of entries) {
    if (!byContentType[e.contentType]) {
      byContentType[e.contentType] = { total: 0, sounds_like_me: 0, not_quite: 0, doesnt_sound_like_me: 0 };
    }
    byContentType[e.contentType].total++;
    byContentType[e.contentType][e.validation]++;
  }

  // Aggregate by validation type
  const byValidation = { sounds_like_me: 0, not_quite: 0, doesnt_sound_like_me: 0 };
  for (const e of entries) {
    byValidation[e.validation]++;
  }

  // Validation rate = sounds_like_me / total
  const validationRate = entries.length > 0
    ? Math.round((byValidation.sounds_like_me / entries.length) * 100) / 100
    : null;

  // Recent trend: compare last 20 vs previous 20
  let recentTrend = null;
  if (entries.length >= 20) {
    const recent20 = entries.slice(-20);
    const previous20 = entries.slice(-40, -20);

    const recentRate = recent20.filter(e => e.validation === 'sounds_like_me').length / 20;

    if (previous20.length >= 10) {
      const prevRate = previous20.filter(e => e.validation === 'sounds_like_me').length / previous20.length;
      const delta = Math.round((recentRate - prevRate) * 100);
      recentTrend = {
        direction: delta > 2 ? 'improving' : delta < -2 ? 'declining' : 'stable',
        recentRate: Math.round(recentRate * 100),
        previousRate: Math.round(prevRate * 100),
        delta
      };
    } else {
      recentTrend = {
        direction: 'insufficient_data',
        recentRate: Math.round(recentRate * 100)
      };
    }
  }

  // Per-provider breakdown
  const byProvider = {};
  for (const e of entries) {
    const key = e.model || e.providerId || 'unknown';
    if (!byProvider[key]) {
      byProvider[key] = { total: 0, sounds_like_me: 0, not_quite: 0, doesnt_sound_like_me: 0 };
    }
    byProvider[key].total++;
    byProvider[key][e.validation]++;
  }

  return {
    totalFeedback: entries.length,
    validationRate,
    byContentType,
    byValidation,
    byProvider,
    recentTrend,
    documentWeightAdjustments: data.documentWeightAdjustments,
    lastCalculatedAt: data.lastCalculatedAt
  };
}

/**
 * Recalculate document weight adjustments based on feedback history.
 *
 * Documents that consistently appear in "sounds like me" responses get boosted.
 * Documents that appear in "doesn't sound like me" responses get reduced.
 * Returns the new weight adjustments (deltas from base weight).
 */
export async function recalculateWeights() {
  const data = await loadFeedback();
  const entries = data.entries.filter(e => e.documentsUsed?.length > 0);

  if (entries.length < 5) {
    return { adjustments: {}, message: 'Need at least 5 feedback entries with document attribution to calculate weights' };
  }

  // Track per-document validation counts
  const docScores = {};
  for (const e of entries) {
    for (const doc of e.documentsUsed) {
      if (!docScores[doc]) docScores[doc] = { positive: 0, neutral: 0, negative: 0, total: 0 };
      docScores[doc].total++;
      if (e.validation === 'sounds_like_me') docScores[doc].positive++;
      else if (e.validation === 'not_quite') docScores[doc].neutral++;
      else docScores[doc].negative++;
    }
  }

  // Calculate weight adjustments
  const adjustments = {};
  for (const [doc, scores] of Object.entries(docScores)) {
    if (scores.total < 3) continue; // Need minimum data points

    const ratio = (scores.positive - scores.negative) / scores.total;

    // Adjustment: +1 for strongly positive docs, -1 for strongly negative
    // Scale: ratio ranges from -1 to +1, map to weight delta of -2 to +2
    const delta = Math.round(ratio * 2 * 10) / 10;
    if (Math.abs(delta) >= 0.5) {
      adjustments[doc] = {
        delta,
        confidence: Math.min(1, scores.total / 10), // How confident we are in this adjustment
        positive: scores.positive,
        negative: scores.negative,
        total: scores.total
      };
    }
  }

  data.documentWeightAdjustments = adjustments;
  data.lastCalculatedAt = now();
  await saveFeedback(data);

  digitalTwinEvents.emit('feedback:weights-recalculated', adjustments);
  console.log(`🔄 Feedback weights recalculated: ${Object.keys(adjustments).length} documents adjusted`);

  return { adjustments };
}

/**
 * Get feedback entries for a specific content type (for UI display).
 */
export async function getRecentFeedback(contentType, limit = 20) {
  const data = await loadFeedback();
  let entries = data.entries;

  if (contentType) {
    entries = entries.filter(e => e.contentType === contentType);
  }

  return entries.slice(-limit).reverse();
}
