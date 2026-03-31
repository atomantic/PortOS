import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { getActiveProvider, getProviderById } from './providers.js';
import { buildPrompt } from './promptService.js';
import { ENRICHMENT_CATEGORIES, SCALE_QUESTIONS, SCALE_WEIGHT, CONFIDENCE_BOOST } from './digital-twin-constants.js';
import { DIGITAL_TWIN_DIR, generateId, now, ensureSoulDir, callProviderAI } from './digital-twin-helpers.js';
import { loadMeta, saveMeta, digitalTwinEvents } from './digital-twin-meta.js';
import { getDigitalTwinForPrompt } from './digital-twin-context.js';
import { generateGapRecommendations } from './digital-twin-analysis.js';

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
  const existingSoul = await getDigitalTwinForPrompt({ maxTokens: 2000 });

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
    const { safeJSONParse } = await import('../lib/fileUtils.js');
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
