/**
 * Insights Service
 *
 * Cross-domain insights engine: correlates genome markers with blood test data
 * (rule-based), generates LLM taste-to-identity themes, and produces cross-domain
 * narrative summaries.
 *
 * Three insight domains:
 *   1. Genome-Health correlations (INS-01) — pure rule-based, no LLM
 *   2. Taste-identity themes (INS-02) — LLM generation, cached to disk
 *   3. Cross-domain narrative (INS-04) — LLM generation with diff support
 */

import { writeFile } from 'fs/promises';
import { join } from 'path';
import { PATHS, ensureDir, readJSONFile } from '../lib/fileUtils.js';
import { getGenomeSummary } from './genome.js';
import { getBloodTests } from './meatspaceHealth.js';
import { MARKER_CATEGORIES } from '../lib/curatedGenomeMarkers.js';
import { getTasteProfile } from './taste-questionnaire.js';
import { getActiveProvider, getProviderById } from './providers.js';
import { getCorrelationData } from './appleHealthQuery.js';

const INSIGHTS_DIR = join(PATHS.data, 'insights');
const THEMES_FILE = join(INSIGHTS_DIR, 'themes.json');
const NARRATIVE_FILE = join(INSIGHTS_DIR, 'narrative.json');

// =============================================================================
// CATEGORY → BLOOD ANALYTE MAPPING
// =============================================================================

const CATEGORY_BLOOD_MAP = {
  cardiovascular: ['total_cholesterol', 'ldl', 'hdl', 'triglycerides', 'homocysteine'],
  iron: ['ferritin', 'serum_iron', 'transferrin_saturation', 'tibc'],
  methylation: ['homocysteine', 'b12', 'folate'],
  diabetes: ['fasting_glucose', 'hba1c', 'insulin'],
  thyroid: ['tsh', 't3', 't4'],
  nutrient: ['vitamin_d', 'b12', 'folate', 'magnesium', 'zinc']
};

// =============================================================================
// CONFIDENCE LEVELS (correlation strength labels — not causal claims)
// =============================================================================

const CONFIDENCE_FROM_STATUS = {
  beneficial: { level: 'strong', color: 'green', label: 'Strong Evidence' },
  typical: { level: 'moderate', color: 'yellow', label: 'Moderate Evidence' },
  concern: { level: 'weak', color: 'red', label: 'Elevated Risk Marker' },
  major_concern: { level: 'significant', color: 'red', label: 'Significant Risk Marker' }
};

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Normalize blood analyte name for consistent lookups.
 * Lowercases, trims, and maps common abbreviation variants.
 */
function normalizeAnalyteName(name) {
  if (!name) return '';
  let normalized = name.toLowerCase().trim();

  // Common abbreviation / label mappings
  const abbreviationMap = {
    'ldl cholesterol': 'ldl',
    'hdl cholesterol': 'hdl',
    'total cholesterol': 'total_cholesterol',
    'cholesterol total': 'total_cholesterol',
    'triglycerides': 'triglycerides',
    'homocysteine': 'homocysteine',
    'ferritin': 'ferritin',
    'serum iron': 'serum_iron',
    'iron': 'serum_iron',
    'transferrin saturation': 'transferrin_saturation',
    'tibc': 'tibc',
    'total iron binding capacity': 'tibc',
    'vitamin b12': 'b12',
    'b12': 'b12',
    'folate': 'folate',
    'folic acid': 'folate',
    'fasting glucose': 'fasting_glucose',
    'glucose': 'fasting_glucose',
    'hba1c': 'hba1c',
    'hemoglobin a1c': 'hba1c',
    'haemoglobin a1c': 'hba1c',
    'insulin': 'insulin',
    'tsh': 'tsh',
    'thyroid stimulating hormone': 'tsh',
    't3': 't3',
    'triiodothyronine': 't3',
    't4': 't4',
    'thyroxine': 't4',
    'vitamin d': 'vitamin_d',
    'vitamin d3': 'vitamin_d',
    '25-hydroxyvitamin d': 'vitamin_d',
    'magnesium': 'magnesium',
    'zinc': 'zinc'
  };

  return abbreviationMap[normalized] ?? normalized.replace(/\s+/g, '_');
}

/**
 * Extract the most recent value for each analyte from the blood tests array.
 * Returns a Map of normalized analyte name → { value, date, unit }.
 */
function getLatestBloodValues(tests) {
  const latest = new Map();

  for (const test of tests) {
    const { date, ...analytes } = test;
    for (const [key, val] of Object.entries(analytes)) {
      if (val === null || val === undefined) continue;

      const normalized = normalizeAnalyteName(key);
      if (!normalized) continue;

      const existing = latest.get(normalized);
      if (!existing || date > existing.date) {
        latest.set(normalized, {
          value: typeof val === 'object' ? val.value : val,
          unit: typeof val === 'object' ? val.unit ?? '' : '',
          date
        });
      }
    }
  }

  return latest;
}

/**
 * Replicate callProviderAISimple pattern from taste-questionnaire.js.
 * API-type providers only. Returns { text } on success, { error } on failure.
 */
async function callProviderAISimple(provider, model, prompt, { temperature = 0.3, max_tokens = 1000 } = {}) {
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
    });

    clearTimeout(timer);

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      return { error: `Provider returned ${response.status}: ${errorText}` };
    }

    const data = await response.json();
    return { text: data.choices?.[0]?.message?.content || '' };
  }

  return { error: 'Insights analysis requires an API-based provider' };
}

/**
 * Strip markdown code fences from LLM output before JSON.parse.
 */
function stripCodeFences(raw) {
  return raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
}

// =============================================================================
// EXPORTED FUNCTIONS
// =============================================================================

/**
 * INS-01: Get genome-health correlations (pure rule-based, no LLM).
 * Groups genome markers by clinical category and matches blood test values.
 *
 * Returns { available: false, reason } when source data is missing.
 * Status labels indicate correlation strength — not causal claims.
 */
export async function getGenomeHealthCorrelations() {
  const summary = await getGenomeSummary();

  if (!summary?.uploaded) {
    return { available: false, reason: 'no_genome' };
  }

  const savedMarkers = summary.savedMarkers ?? {};

  // Filter out not_found markers
  const activeMarkers = Object.values(savedMarkers).filter(m => m.status !== 'not_found');

  // Fetch blood test data in parallel (fail gracefully)
  let bloodValues = new Map();
  let hasBlooodData = false;
  const bloodData = await getBloodTests().catch(() => null);
  if (bloodData?.tests?.length) {
    bloodValues = getLatestBloodValues(bloodData.tests);
    hasBlooodData = true;
  }

  // Group markers by category
  const categoryMap = {};
  for (const marker of activeMarkers) {
    const cat = marker.category;
    if (!cat) continue;
    if (!categoryMap[cat]) {
      categoryMap[cat] = { markers: [], notFoundCount: 0 };
    }
    categoryMap[cat].markers.push(marker);
  }

  // Count not_found per category for context
  for (const marker of Object.values(savedMarkers)) {
    if (marker.status === 'not_found' && marker.category) {
      if (!categoryMap[marker.category]) {
        categoryMap[marker.category] = { markers: [], notFoundCount: 0 };
      }
      categoryMap[marker.category].notFoundCount++;
    }
  }

  // Build category output
  const categories = [];
  for (const [catKey, catData] of Object.entries(categoryMap)) {
    const catMeta = MARKER_CATEGORIES[catKey];
    const mappedAnalytes = CATEGORY_BLOOD_MAP[catKey] ?? [];

    const enrichedMarkers = catData.markers.map(marker => {
      const confidence = CONFIDENCE_FROM_STATUS[marker.status] ?? null;

      const matchedBloodValues = mappedAnalytes
        .map(analyte => {
          const hit = bloodValues.get(analyte);
          return hit ? { analyte, ...hit } : null;
        })
        .filter(Boolean);

      return {
        rsid: marker.rsid,
        gene: marker.gene,
        name: marker.name,
        status: marker.status,
        description: marker.description,
        implications: marker.implications,
        confidence,
        matchedBloodValues,
        references: marker.references ?? []
      };
    });

    categories.push({
      category: catKey,
      label: catMeta?.label ?? catKey,
      icon: catMeta?.icon ?? 'Circle',
      color: catMeta?.color ?? 'gray',
      markers: enrichedMarkers,
      notFoundCount: catData.notFoundCount
    });
  }

  // Determine sources
  const sources = ['23andMe'];
  if (hasBlooodData) sources.push('Blood Tests');

  // Check for Apple Health data availability
  const appleHealthData = await getCorrelationData(
    new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    new Date().toISOString().slice(0, 10)
  ).catch(() => null);
  if (appleHealthData) sources.push('Apple Health');

  const totalMarkers = Object.values(savedMarkers).length;
  const matchedMarkers = activeMarkers.length;

  return {
    available: true,
    categories,
    totalMarkers,
    matchedMarkers,
    sources
  };
}

/**
 * INS-02: Return cached taste-identity themes (no generation).
 * Returns { available: false, reason: 'not_generated' } if no cache exists.
 */
export async function getThemeAnalysis() {
  const cached = await readJSONFile(THEMES_FILE, null);
  if (!cached) {
    return { available: false, reason: 'not_generated' };
  }
  return { ...cached, available: true };
}

/**
 * INS-02: Generate taste-identity themes via LLM and persist to disk.
 * Reads taste profile sections, constructs prompt, parses JSON response.
 *
 * @param {string} [providerId] - Optional provider ID override
 * @param {string} [model] - Optional model override
 */
export async function generateThemeAnalysis(providerId, model) {
  const tasteProfile = await getTasteProfile();

  const completedSections = (tasteProfile?.sections ?? []).filter(s => s.summary);
  if (!completedSections.length) {
    return { available: false, reason: 'no_taste_data' };
  }

  const provider = providerId
    ? await getProviderById(providerId)
    : await getActiveProvider();

  if (!provider) {
    return { available: false, reason: 'no_provider' };
  }

  const selectedModel = model ?? provider.defaultModel;

  const sectionContext = completedSections
    .map(s => `## ${s.label}\n${s.summary}`)
    .join('\n\n');

  const prompt = `You are analyzing taste preference data to identify patterns that reveal identity-level themes.

The data below contains questionnaire summaries across different aesthetic and lifestyle domains.

${sectionContext}

Based on these preference summaries, identify 3-5 cross-domain themes that reveal this person's core aesthetic identity and values. The data indicates patterns — analyze them objectively.

Respond with a JSON array only (no markdown fences, no explanation). Each element must have:
- "title": short theme name (3-6 words)
- "narrative": 2-3 sentence analytical description in third-person ("The data indicates...", "This pattern suggests...")
- "evidence": array of objects with "preference" (specific preference observed), "domain" (which section), "connection" (how it connects to the theme)
- "strength": one of "strong", "moderate", "tentative"

Example format:
[{"title":"...","narrative":"...","evidence":[{"preference":"...","domain":"...","connection":"..."}],"strength":"strong"}]`;

  const result = await callProviderAISimple(provider, selectedModel, prompt, {
    temperature: 0.4,
    max_tokens: 2000
  });

  if (result.error) {
    return { available: false, reason: result.error };
  }

  const themes = JSON.parse(stripCodeFences(result.text));

  await ensureDir(INSIGHTS_DIR);
  const output = {
    themes,
    generatedAt: new Date().toISOString(),
    model: selectedModel
  };
  await writeFile(THEMES_FILE, JSON.stringify(output, null, 2));

  console.log(`🧠 Taste-identity themes generated: ${themes.length} themes`);

  return { themes, generatedAt: output.generatedAt };
}

/**
 * INS-04: Return cached cross-domain narrative (no generation).
 * Returns { available: false, reason: 'not_generated' } if no cache exists.
 */
export async function getCrossDomainNarrative() {
  const cached = await readJSONFile(NARRATIVE_FILE, null);
  if (!cached) {
    return { available: false, reason: 'not_generated' };
  }
  return { ...cached, available: true };
}

/**
 * INS-04: Generate cross-domain narrative via LLM with diff support.
 * Gathers genome, taste-identity, and Apple Health context; writes narrative
 * to disk preserving previousText for client-side diff.
 *
 * @param {string} [providerId] - Optional provider ID override
 * @param {string} [model] - Optional model override
 */
export async function refreshCrossDomainNarrative(providerId, model) {
  // Load existing narrative for diff support
  const existingNarrative = await readJSONFile(NARRATIVE_FILE, null);

  const provider = providerId
    ? await getProviderById(providerId)
    : await getActiveProvider();

  if (!provider) {
    return { available: false, reason: 'no_provider' };
  }

  const selectedModel = model ?? provider.defaultModel;

  // Gather context from all domains
  const [genomeCorrResult, themeResult, appleHealthData] = await Promise.all([
    getGenomeHealthCorrelations().catch(() => null),
    getThemeAnalysis().catch(() => null),
    getCorrelationData(
      new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      new Date().toISOString().slice(0, 10)
    ).catch(() => null)
  ]);

  // Build context sections
  const contextParts = [];

  if (genomeCorrResult?.available) {
    const topCategories = genomeCorrResult.categories
      .filter(c => c.markers.length > 0)
      .slice(0, 6)
      .map(c => `- ${c.label}: ${c.markers.map(m => m.name ?? m.gene).join(', ')}`)
      .join('\n');
    contextParts.push(`GENOME HEALTH MARKERS:\n${topCategories}`);
  }

  if (themeResult?.themes?.length) {
    const themes = themeResult.themes
      .map(t => `- ${t.title} (${t.strength}): ${t.narrative}`)
      .join('\n');
    contextParts.push(`TASTE-IDENTITY THEMES:\n${themes}`);
  }

  if (appleHealthData) {
    contextParts.push('APPLE HEALTH: Activity and biometric data available.');
  }

  if (!contextParts.length) {
    return { available: false, reason: 'no_data' };
  }

  const prompt = `You are generating a cross-domain personal narrative based on health, genome, and lifestyle data.

${contextParts.join('\n\n')}

Write a 2-3 paragraph analytical narrative in second person ("Your data shows...") that synthesizes patterns across these domains. Be specific but accessible. Focus on actionable insights and meaningful connections between domains. Do not make medical claims — frame findings as patterns and correlations.

Respond with only the narrative text, no JSON, no headings, no markdown.`;

  const result = await callProviderAISimple(provider, selectedModel, prompt, {
    temperature: 0.5,
    max_tokens: 2000
  });

  if (result.error) {
    return { available: false, reason: result.error };
  }

  const newText = stripCodeFences(result.text);

  await ensureDir(INSIGHTS_DIR);
  const output = {
    text: newText,
    previousText: existingNarrative?.text ?? null,
    generatedAt: new Date().toISOString(),
    previousGeneratedAt: existingNarrative?.generatedAt ?? null,
    model: selectedModel
  };
  await writeFile(NARRATIVE_FILE, JSON.stringify(output, null, 2));

  console.log(`🔮 Cross-domain narrative generated (${newText.length} chars)`);

  return output;
}
