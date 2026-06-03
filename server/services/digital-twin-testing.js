import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { getProviderById } from './providers.js';
import { buildPrompt } from './promptService.js';
import { DIGITAL_TWIN_DIR, generateId, now, callProviderAI, parseScorerVerdict, resolveTestPersona } from './digital-twin-helpers.js';
import { loadMeta, saveMeta, cache, CACHE_TTL_MS } from './digital-twin-meta.js';
import { getDigitalTwinForPrompt } from './digital-twin-context.js';

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

export async function runTests(providerId, model, testIds = null, personaId = null) {
  const tests = await parseTestSuite();
  // When a persona is selected the embodied context is flavored with that
  // persona's instructions, so the suite measures how the twin behaves *as*
  // that persona (P7 "per-persona testing"); with none it tests the base twin.
  const soulContext = await getDigitalTwinForPrompt(personaId ? { personaId } : {});

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

  const meta = await loadMeta();

  // Save to history (attributed to the persona it embodied, if any)
  const historyEntry = {
    runId: generateId(),
    providerId,
    model,
    ...resolveTestPersona(meta.personas, personaId),
    score: testsToRun.length > 0 ? (passed + partial * 0.5) / testsToRun.length : 0,
    passed,
    failed,
    partial,
    total: testsToRun.length,
    timestamp: now()
  };

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

  const result = await callProviderAI(provider, model, combinedPrompt);
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
  const result = await callProviderAI(provider, model, prompt);

  if (!result.error && result.text) {
    return parseScorerVerdict(result.text, ['passed', 'failed']);
  }

  // Default fallback
  return { result: 'partial', reasoning: 'Unable to score - defaulting to partial' };
}

export async function getTestHistory(limit = 10) {
  const meta = await loadMeta();
  return meta.testHistory.slice(0, limit);
}
