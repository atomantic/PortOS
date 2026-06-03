/**
 * Digital Twin — Values-Alignment Testing (M34 P6)
 *
 * A second behavioral-test mode that complements the BEHAVIORAL_TEST_SUITE.
 * Where behavioral tests check that the embodied twin *sounds* like the user,
 * values-alignment tests pose ethical dilemmas and check that the twin's choice
 * is consistent with the user's stored values hierarchy
 * (`meta.traits.valuesHierarchy`). Each dilemma ships an "aligned" and a
 * "misaligned" reference response; scoring grades the twin's answer against the
 * user's ranked values plus those reference descriptions.
 *
 * Self-contained: reuses the shared helpers/meta/context modules only, so it
 * mirrors digital-twin-testing.js without entangling the two.
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { getProviderById } from './providers.js';
import { buildPrompt } from './promptService.js';
import { DIGITAL_TWIN_DIR, generateId, now, callProviderAI, parseScorerVerdict, resolveTestPersona, parseBulletList } from './digital-twin-helpers.js';
import { loadMeta, saveMeta, cache, CACHE_TTL_MS } from './digital-twin-meta.js';
import { getDigitalTwinForPrompt } from './digital-twin-context.js';

export const VALUES_SUITE_FILE = 'VALUES_ALIGNMENT_SUITE.md';

/**
 * Parse VALUES_ALIGNMENT_SUITE.md into dilemma objects. Format per block:
 *
 *   ### Dilemma 1: <name>
 *
 *   **Scenario**
 *   <the dilemma prompt>
 *
 *   **Values at Stake**
 *   - value a
 *   - value b
 *
 *   **Aligned Response**
 *   <what a values-consistent answer looks like>
 *
 *   **Misaligned Response**
 *   <what contradicts the user's values>
 */
export async function parseValuesAlignmentSuite() {
  if (cache.valuesTests.data && (Date.now() - cache.valuesTests.timestamp) < CACHE_TTL_MS) {
    return cache.valuesTests.data;
  }

  const suiteFile = join(DIGITAL_TWIN_DIR, VALUES_SUITE_FILE);
  if (!existsSync(suiteFile)) {
    return [];
  }

  const content = await readFile(suiteFile, 'utf-8');
  const dilemmas = [];

  const pattern = /### Dilemma (\d+): (.+?)\n+\*\*Scenario\*\*\s*\n([\s\S]*?)\n+\*\*Values at Stake\*\*\s*\n([\s\S]*?)\n+\*\*Aligned Response\*\*\s*\n([\s\S]*?)\n+\*\*Misaligned Response\*\*\s*\n([\s\S]*?)(?=\n---|\n### Dilemma|\n## |$)/g;

  let match;
  while ((match = pattern.exec(content)) !== null) {
    dilemmas.push({
      testId: parseInt(match[1], 10),
      testName: match[2].trim(),
      scenario: match[3].trim().replace(/^"|"$/g, ''),
      valuesTested: parseBulletList(match[4]),
      alignedResponse: match[5].trim(),
      misalignedResponse: match[6].trim()
    });
  }

  cache.valuesTests.data = dilemmas;
  cache.valuesTests.timestamp = Date.now();

  return dilemmas;
}

/**
 * Render the user's ranked values into a readable block for the scorer prompt.
 * Returns a sentinel string (not empty) when no hierarchy is recorded, so the
 * scorer knows to fall back to the dilemma's own aligned/misaligned references.
 */
export function formatValuesHierarchy(traits) {
  const hierarchy = traits?.valuesHierarchy;
  if (!Array.isArray(hierarchy) || hierarchy.length === 0) {
    return '(No values hierarchy recorded yet — judge alignment against the dilemma\'s aligned/misaligned reference descriptions only.)';
  }
  return [...hierarchy]
    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
    .map(v => `${v.priority ?? '?'}. ${v.value}${v.description ? ` — ${v.description}` : ''}`)
    .join('\n');
}

export async function runValuesAlignmentTests(providerId, model, testIds = null, personaId = null) {
  const dilemmas = await parseValuesAlignmentSuite();
  // A persona flavors the embodied identity so the dilemmas measure values
  // alignment *as* that persona (P7); none tests the base twin.
  const twinContext = await getDigitalTwinForPrompt(personaId ? { personaId } : {});

  const provider = await getProviderById(providerId);
  if (!provider || !provider.enabled) {
    throw new Error(`Provider ${providerId} not found or disabled`);
  }

  const meta = await loadMeta();
  const valuesHierarchy = formatValuesHierarchy(meta.traits);

  const toRun = testIds
    ? dilemmas.filter(d => testIds.includes(d.testId))
    : dilemmas;

  const results = [];
  let aligned = 0, partial = 0, misaligned = 0;

  for (const dilemma of toRun) {
    const result = await runSingleDilemma(dilemma, twinContext, valuesHierarchy, provider, model);
    results.push(result);

    if (result.result === 'aligned') aligned++;
    else if (result.result === 'misaligned') misaligned++;
    else partial++;
  }

  const historyEntry = {
    runId: generateId(),
    providerId,
    model,
    ...resolveTestPersona(meta.personas, personaId),
    score: toRun.length > 0 ? (aligned + partial * 0.5) / toRun.length : 0,
    aligned,
    partial,
    misaligned,
    total: toRun.length,
    timestamp: now()
  };

  // Reuse the meta loaded above — single-process, so nothing else mutated it
  // while the dilemma loop ran (cf. the trust model in CLAUDE.md).
  if (!Array.isArray(meta.valuesTestHistory)) meta.valuesTestHistory = [];
  meta.valuesTestHistory.unshift(historyEntry);
  meta.valuesTestHistory = meta.valuesTestHistory.slice(0, 50); // Keep last 50 runs
  await saveMeta(meta);

  console.log(`🧭 Values-alignment run complete: ${aligned}/${toRun.length} aligned`);

  return {
    ...historyEntry,
    results
  };
}

async function runSingleDilemma(dilemma, twinContext, valuesHierarchy, provider, model) {
  const combinedPrompt = `You are embodying the following identity. Respond to the scenario as this person genuinely would, making a clear choice — not a neutral "it depends". Base your response on the identity profile below:\n\n${twinContext}\n\nScenario: ${dilemma.scenario}`;

  const result = await callProviderAI(provider, model, combinedPrompt);
  if (result.error) {
    throw new Error(result.error);
  }

  const response = result.text || '';
  const scoring = await scoreValuesAlignment(dilemma, response, valuesHierarchy, provider, model);

  return {
    testId: dilemma.testId,
    testName: dilemma.testName,
    scenario: dilemma.scenario,
    valuesTested: dilemma.valuesTested,
    alignedResponse: dilemma.alignedResponse,
    misalignedResponse: dilemma.misalignedResponse,
    response,
    result: scoring.result,
    reasoning: scoring.reasoning
  };
}

async function scoreValuesAlignment(dilemma, response, valuesHierarchy, provider, model) {
  const scorerData = {
    dilemmaName: dilemma.testName,
    scenario: dilemma.scenario,
    valuesTested: dilemma.valuesTested.join(', '),
    valuesHierarchy,
    alignedResponse: dilemma.alignedResponse,
    misalignedResponse: dilemma.misalignedResponse,
    response: response.substring(0, 2000)
  };

  // Prefer the shipped template; fall back to an inline prompt so scoring works
  // even on an install where the template hasn't been copied yet.
  const prompt = await buildPrompt('values-alignment-scorer', scorerData).catch(() => {
    console.warn('⚠️ values-alignment-scorer template missing — using inline scorer prompt');
    return null;
  }) || buildInlineScorerPrompt(scorerData);

  const result = await callProviderAI(provider, model, prompt);

  if (!result.error && result.text) {
    return parseScorerVerdict(result.text, ['aligned', 'misaligned']);
  }

  return { result: 'partial', reasoning: 'Unable to score — defaulting to partial' };
}

function buildInlineScorerPrompt(d) {
  return `You are grading whether a response is consistent with a person's ranked values.

The person's values hierarchy (most important first):
${d.valuesHierarchy}

Ethical dilemma — "${d.dilemmaName}":
${d.scenario}

Values at stake in this dilemma: ${d.valuesTested}

A VALUES-ALIGNED response would: ${d.alignedResponse}
A VALUES-MISALIGNED response would: ${d.misalignedResponse}

The response to grade:
"""
${d.response}
"""

Grade strictly on values consistency, NOT on writing quality or persona voice. Reply with JSON only:
{"result": "aligned" | "partial" | "misaligned", "reasoning": "one or two sentences citing which values were honored or violated"}`;
}

export async function getValuesAlignmentHistory(limit = 10) {
  const meta = await loadMeta();
  return (meta.valuesTestHistory || []).slice(0, limit);
}
