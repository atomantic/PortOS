import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { getProviderById } from './providers.js';
import { buildPrompt } from './promptService.js';
import { safeJSONParse } from '../lib/fileUtils.js';
import { DIGITAL_TWIN_DIR, callProviderAI, now } from './digital-twin-helpers.js';
import { loadMeta, saveMeta, digitalTwinEvents } from './digital-twin-meta.js';
import { getDocuments } from './digital-twin-documents.js';
import { getDigitalTwinForPrompt } from './digital-twin-context.js';
import { ENRICHMENT_CATEGORIES } from './digital-twin-constants.js';

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
  const soulContent = await getDigitalTwinForPrompt({ maxTokens: 8000 });

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
// TRAIT ANALYSIS & CONFIDENCE SCORING
// =============================================================================

/**
 * Get all twin content for analysis (excludes behavioral tests)
 */
export async function getAllTwinContent() {
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

export function parseTraitsResponse(response) {
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

export function generateGapRecommendations(dimensions) {
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
