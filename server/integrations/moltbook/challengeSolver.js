/**
 * Moltbook Challenge Solver
 *
 * Solves Moltbook's AI verification challenges — obfuscated math word problems
 * that agents must answer to publish posts.
 *
 * Challenge format:
 *   - Text has random brackets/symbols injected and letters doubled with case-swapped duplicates
 *   - Contains a simple arithmetic problem (addition, subtraction, etc.)
 *   - Answer must be a number with 2 decimal places (e.g., "47.00")
 *
 * Uses AI for interpretation — supports both API and CLI providers.
 */

import { executeApiRun, executeCliRun, createRun } from '../../services/runner.js';
import { getActiveProvider, getProviderById } from '../../services/providers.js';

/**
 * Solve using AI interpretation (supports both API and CLI providers)
 */
async function solveWithAI(challengeText, aiConfig) {
  let provider;
  if (aiConfig?.providerId) {
    provider = await getProviderById(aiConfig.providerId).catch(() => null);
  }
  if (!provider) {
    provider = await getActiveProvider();
  }
  if (!provider) {
    console.log(`🔐 No AI provider available for challenge solving`);
    return null;
  }

  const model = aiConfig?.model || provider.lightModel || provider.defaultModel || provider.models?.[0];
  const prompt = `You are solving a verification challenge. The text below is obfuscated with random brackets, symbols, and doubled letters. Decode it, solve the math problem, and respond with ONLY the numeric answer with 2 decimal places (e.g., "47.00"). No explanation.

Challenge text:
${challengeText}

Answer:`;

  const { runId } = await createRun({
    providerId: provider.id,
    model,
    prompt,
    source: 'moltbook-challenge'
  });

  let responseText = '';
  const isCliProvider = provider.type === 'cli';

  await new Promise((resolve, reject) => {
    if (isCliProvider) {
      executeCliRun(
        runId,
        provider,
        prompt,
        process.cwd(),
        (text) => { responseText += text; },
        (result) => {
          if (result?.error || result?.success === false) {
            reject(new Error(result?.error || 'CLI execution failed'));
          } else {
            resolve(result);
          }
        },
        provider.timeout || 300000
      );
    } else {
      executeApiRun(
        runId,
        provider,
        model,
        prompt,
        process.cwd(),
        [],
        (data) => { responseText += typeof data === 'string' ? data : (data?.text || ''); },
        (result) => {
          if (result?.error) reject(new Error(result.error));
          else resolve(result);
        }
      );
    }
  });

  // Extract number from response
  const numMatch = responseText.trim().match(/[\d]+\.?\d*/);
  if (numMatch) {
    return parseFloat(numMatch[0]);
  }

  console.log(`🔐 AI response didn't contain a number: "${responseText.substring(0, 100)}"`);
  return null;
}

/**
 * Solve a Moltbook verification challenge
 * @param {string} challengeText - The obfuscated challenge text
 * @param {{ providerId?: string, model?: string }} [aiConfig] - Optional AI provider config
 * @returns {string|null} Answer formatted with 2 decimal places, or null if unsolvable
 */
export async function solveChallenge(challengeText, aiConfig) {
  console.log(`🔐 Solving challenge: "${challengeText.substring(0, 80)}..."`);

  const aiAnswer = await solveWithAI(challengeText, aiConfig).catch(err => {
    console.log(`🔐 AI solver error: ${err.message}`);
    return null;
  });
  if (aiAnswer !== null) {
    const formatted = aiAnswer.toFixed(2);
    console.log(`🔐 AI solver: ${formatted}`);
    return formatted;
  }

  console.error(`❌ Could not solve Moltbook challenge — no AI provider available`);
  return null;
}
