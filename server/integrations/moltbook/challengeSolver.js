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
 * The challenge is third-party text. It is screened through the moltbook
 * untrusted-content boundary, which admits only an enabled text API provider.
 */

import { z } from 'zod';
import { isUntrustedContentProvider } from '../../lib/untrustedContent.js';
import { getProviderById } from '../../services/providers.js';
import { runUntrustedContentAnalysis } from '../../services/untrustedContent.js';

const answerSchema = z.string().regex(/^-?\d+\.\d{2}$/);

const CHALLENGE_PROMPT = `Solve the verification challenge in the untrusted-content envelope. The text is obfuscated with random brackets, symbols, and doubled letters. Decode it and solve the math problem. Return only a JSON string with exactly two decimal places, such as "47.00".`;

/**
 * A saved pin is used as-is. An ineligible CLI/TUI provider fails here instead
 * of being replaced by the active provider. No pin lets the untrusted-content
 * boundary choose an eligible text API provider.
 */
async function solveWithAI(challengeText, aiConfig) {
  let provider = null;
  if (aiConfig?.providerId) {
    provider = await getProviderById(aiConfig.providerId).catch(() => null);
    if (!isUntrustedContentProvider(provider, 'moltbook')) {
      console.warn('⛔ Skipped Moltbook challenge (untrusted-content-provider-unavailable)');
      return null;
    }
  }

  const result = await runUntrustedContentAnalysis({
    ...(provider ? { provider } : {}),
    ...(aiConfig?.model ? { model: aiConfig.model } : {}),
    content: challengeText,
    prompt: CHALLENGE_PROMPT,
    source: 'moltbook',
    responseSchema: answerSchema,
  });
  if (!result?.ok || typeof result.value !== 'string') {
    console.warn(`⛔ Skipped Moltbook challenge (${result?.code || 'untrusted-content-rejected'})`);
    return null;
  }
  return result.value;
}

/**
 * Solve a Moltbook verification challenge
 * @param {string} challengeText - The obfuscated challenge text
 * @param {{ providerId?: string, model?: string }} [aiConfig] - Optional AI provider config
 * @returns {Promise<string|null>} Answer formatted with 2 decimal places, or null if unsolvable
 */
export async function solveChallenge(challengeText, aiConfig) {
  return solveWithAI(challengeText, aiConfig).catch(err => {
    console.error(`❌ Moltbook challenge solver error: ${err.message}`);
    return null;
  });
}
