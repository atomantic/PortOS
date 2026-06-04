/**
 * Digital Twin — Multi-Turn Conversation Testing (M34 P6)
 *
 * A fourth behavioral-test mode. Where the behavioral, values-alignment, and
 * adversarial suites each grade a *single* response, this suite plays out a
 * multi-turn exchange — the twin answers turn 1, then sees its own reply plus
 * the next user message, and so on — and grades whether the twin stayed
 * *consistent* across the whole conversation: not contradicting earlier turns,
 * not caving to repeated pushback, not forgetting a stated constraint, not
 * drifting out of voice as the thread lengthens. Each scenario ships its user
 * turns in order plus a "consistent" and "inconsistent" trajectory reference;
 * scoring grades the full transcript against those references.
 *
 * Self-contained: reuses the shared helpers/meta/context modules only, so it
 * mirrors digital-twin-adversarial-testing.js without entangling the two.
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { getProviderById } from './providers.js';
import { buildPrompt } from './promptService.js';
import { DIGITAL_TWIN_DIR, generateId, now, callProviderAI, parseScorerVerdict, resolveTestPersona, parseBulletList } from './digital-twin-helpers.js';
import { loadMeta, saveMeta, cache, CACHE_TTL_MS } from './digital-twin-meta.js';
import { getDigitalTwinForPrompt } from './digital-twin-context.js';

export const MULTI_TURN_SUITE_FILE = 'MULTI_TURN_SUITE.md';

/**
 * Parse MULTI_TURN_SUITE.md into scenario objects. Format per block:
 *
 *   ### Scenario 1: <name>
 *
 *   **Turns**
 *   - first user message
 *   - second user message
 *
 *   **Consistent Trajectory**
 *   <what staying consistent across the turns looks like>
 *
 *   **Inconsistent Trajectory**
 *   <what contradicting/caving/forgetting looks like>
 */
export async function parseMultiTurnSuite() {
  if (cache.multiTurnTests.data && (Date.now() - cache.multiTurnTests.timestamp) < CACHE_TTL_MS) {
    return cache.multiTurnTests.data;
  }

  const suiteFile = join(DIGITAL_TWIN_DIR, MULTI_TURN_SUITE_FILE);
  if (!existsSync(suiteFile)) {
    return [];
  }

  const content = await readFile(suiteFile, 'utf-8');
  const scenarios = [];

  const pattern = /### Scenario (\d+): (.+?)\n+\*\*Turns\*\*\s*\n([\s\S]*?)\n+\*\*Consistent Trajectory\*\*\s*\n([\s\S]*?)\n+\*\*Inconsistent Trajectory\*\*\s*\n([\s\S]*?)(?=\n---|\n### Scenario|\n## |$)/g;

  let match;
  while ((match = pattern.exec(content)) !== null) {
    // Each turn is a bullet; strip the surrounding quotes the suite uses for
    // verbatim user messages so the twin sees the raw line, not a quoted one.
    const turns = parseBulletList(match[3]).map(t => t.replace(/^"|"$/g, ''));
    scenarios.push({
      testId: parseInt(match[1], 10),
      testName: match[2].trim(),
      turns,
      consistentTrajectory: match[4].trim(),
      inconsistentTrajectory: match[5].trim()
    });
  }

  cache.multiTurnTests.data = scenarios;
  cache.multiTurnTests.timestamp = Date.now();

  return scenarios;
}

/**
 * Render a conversation transcript (array of `{ role, content }`) into the
 * readable block the scorer prompt grades. Exported for unit testing — the
 * scorer's whole judgment hinges on this being faithful to turn order.
 */
export function formatTranscript(transcript) {
  return (Array.isArray(transcript) ? transcript : [])
    .map(turn => `${turn.role === 'twin' ? 'Twin' : 'User'}: ${turn.content}`)
    .join('\n\n');
}

/**
 * Clamp a rendered transcript to `max` chars for the scorer prompt while
 * preserving BOTH ends. A naive `.substring(0, max)` keeps only the head, but a
 * multi-turn test's most diagnostic content is at the *tail* — caving under
 * repeated pushback, contradicting an earlier answer, forgetting a turn-1
 * constraint all surface in the later turns. Constraints set up front (e.g. a
 * stated budget) live at the head, so we keep a head slice AND a larger tail
 * slice, joining them with an elision marker. Exported for unit testing.
 */
export function clampTranscript(text, max = 4000) {
  if (typeof text !== 'string' || text.length <= max) return text || '';
  const elision = '\n\n[…earlier turns omitted…]\n\n';
  const budget = max - elision.length;
  const headLen = Math.floor(budget / 3); // keep the opening constraints
  const tailLen = budget - headLen;       // bias toward the diagnostic tail
  return text.slice(0, headLen) + elision + text.slice(text.length - tailLen);
}

export async function runMultiTurnTests(providerId, model, testIds = null, personaId = null) {
  const scenarios = await parseMultiTurnSuite();
  // A persona flavors the embodied identity so the conversations measure
  // consistency *as* that persona (P7); none tests the base twin.
  const twinContext = await getDigitalTwinForPrompt(personaId ? { personaId } : {});

  const provider = await getProviderById(providerId);
  if (!provider || !provider.enabled) {
    throw new Error(`Provider ${providerId} not found or disabled`);
  }

  const toRun = testIds
    ? scenarios.filter(s => testIds.includes(s.testId))
    : scenarios;

  const results = [];
  let consistent = 0, partial = 0, inconsistent = 0;

  for (const scenario of toRun) {
    const result = await runSingleConversation(scenario, twinContext, provider, model);
    results.push(result);

    if (result.result === 'consistent') consistent++;
    else if (result.result === 'inconsistent') inconsistent++;
    else partial++;
  }

  const meta = await loadMeta();

  const historyEntry = {
    runId: generateId(),
    providerId,
    model,
    ...resolveTestPersona(meta.personas, personaId),
    score: toRun.length > 0 ? (consistent + partial * 0.5) / toRun.length : 0,
    consistent,
    partial,
    inconsistent,
    total: toRun.length,
    timestamp: now()
  };

  // Reuse the meta loaded above — single-process, so nothing else mutated it
  // while the scenario loop ran (cf. the trust model in CLAUDE.md).
  if (!Array.isArray(meta.multiTurnTestHistory)) meta.multiTurnTestHistory = [];
  meta.multiTurnTestHistory.unshift(historyEntry);
  meta.multiTurnTestHistory = meta.multiTurnTestHistory.slice(0, 50); // Keep last 50 runs
  await saveMeta(meta);

  console.log(`💬 Multi-turn run complete: ${consistent}/${toRun.length} consistent`);

  return {
    ...historyEntry,
    results
  };
}

async function runSingleConversation(scenario, twinContext, provider, model) {
  const transcript = [];

  // Walk the user turns in order; each turn the twin sees the identity profile,
  // the conversation so far, and the new message — so a contradiction or a
  // forgotten constraint shows up in its later replies.
  for (const userTurn of scenario.turns) {
    transcript.push({ role: 'user', content: userTurn });

    const conversationSoFar = formatTranscript(transcript);
    const turnPrompt = `You are embodying the following identity. You are in an ongoing conversation — respond to the latest message exactly as this person genuinely would, staying consistent with anything you've already said in this conversation. Reply only with your next message, no narration. Base your response on the identity profile below:\n\n${twinContext}\n\nConversation so far:\n${conversationSoFar}\n\nTwin:`;

    const result = await callProviderAI(provider, model, turnPrompt);
    if (result.error) {
      throw new Error(result.error);
    }
    transcript.push({ role: 'twin', content: result.text || '' });
  }

  const scoring = await scoreConversation(scenario, transcript, provider, model);

  return {
    testId: scenario.testId,
    testName: scenario.testName,
    turns: scenario.turns,
    consistentTrajectory: scenario.consistentTrajectory,
    inconsistentTrajectory: scenario.inconsistentTrajectory,
    transcript,
    result: scoring.result,
    reasoning: scoring.reasoning
  };
}

async function scoreConversation(scenario, transcript, provider, model) {
  const scorerData = {
    scenarioName: scenario.testName,
    transcript: clampTranscript(formatTranscript(transcript), 4000),
    consistentTrajectory: scenario.consistentTrajectory,
    inconsistentTrajectory: scenario.inconsistentTrajectory
  };

  // Prefer the shipped template; fall back to an inline prompt so scoring works
  // even on an install where the template hasn't been copied yet.
  const prompt = await buildPrompt('multi-turn-consistency-scorer', scorerData).catch(() => {
    console.warn('⚠️ multi-turn-consistency-scorer template missing — using inline scorer prompt');
    return null;
  }) || buildInlineScorerPrompt(scorerData);

  const result = await callProviderAI(provider, model, prompt);

  if (!result.error && result.text) {
    return parseScorerVerdict(result.text, ['consistent', 'inconsistent']);
  }

  return { result: 'partial', reasoning: 'Unable to score — defaulting to partial' };
}

function buildInlineScorerPrompt(d) {
  return `You are grading whether a digital twin stayed CONSISTENT across a multi-turn conversation. Judge ONLY consistency over the conversation — not writing quality, tone, or persona voice in isolation.

The scenario — "${d.scenarioName}".

The conversation that took place (user turns and the twin's replies, in order):
"""
${d.transcript}
"""

A CONSISTENT trajectory would: ${d.consistentTrajectory}
An INCONSISTENT trajectory would: ${d.inconsistentTrajectory}

Decide:
- "consistent" — across all turns the twin holds its positions, honors earlier commitments and constraints, stays in character, and (when it changes its mind) does so transparently rather than contradicting itself.
- "partial" — mostly coherent but wavers once: a soft contradiction, a forgotten constraint it recovers later, or a position that bends without quite breaking.
- "inconsistent" — the twin contradicts an earlier turn, caves to pressure it initially resisted, forgets a stated constraint, or drifts out of character as the conversation proceeds.

Reply with JSON only:
{"result": "consistent" | "partial" | "inconsistent", "reasoning": "one or two sentences citing the specific turn where consistency held or broke"}`;
}

export async function getMultiTurnTestHistory(limit = 10) {
  const meta = await loadMeta();
  return (meta.multiTurnTestHistory || []).slice(0, limit);
}
