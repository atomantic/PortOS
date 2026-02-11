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
 * Uses AI for interpretation when available, with a regex fallback.
 */

import { executeApiRun, createRun } from '../../services/runner.js';
import { getActiveProvider, getProviderById } from '../../services/providers.js';

/**
 * Strip obfuscation noise from Moltbook challenge text
 * Removes: brackets, carets, braces, then collapses consecutive case-insensitive duplicate letters
 */
export function cleanChallengeText(text) {
  // Strip bracket/symbol noise
  let cleaned = text.replace(/[[\]{}^]/g, '');

  // Collapse consecutive case-insensitive duplicate letters
  // e.g., "LoOoBbSsTtEeR" -> "LoBSTER" (lobster)
  let result = '';
  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i];
    const prev = result[result.length - 1];
    if (prev && char.toLowerCase() === prev.toLowerCase()) continue;
    result += char;
  }

  // Normalize whitespace
  return result.replace(/\s+/g, ' ').trim();
}

// Word-to-number mapping for fallback solver
const WORD_NUMBERS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000
};

/**
 * Parse a number from word representation (e.g., "thirty five" -> 35)
 */
function wordsToNumber(words) {
  const tokens = words.toLowerCase().split(/[\s-]+/);
  let total = 0;
  let current = 0;

  for (const token of tokens) {
    const val = WORD_NUMBERS[token];
    if (val === undefined) continue;
    if (val === 100) {
      current = (current || 1) * 100;
    } else if (val === 1000) {
      current = (current || 1) * 1000;
      total += current;
      current = 0;
    } else {
      current += val;
    }
  }

  return total + current;
}

/**
 * Attempt to solve the challenge using regex-based number extraction and arithmetic
 */
export function solveWithRegex(challengeText) {
  const cleaned = cleanChallengeText(challengeText);
  console.log(`🔐 Cleaned challenge: "${cleaned}"`);

  // Try to find numeric values (digit-based)
  const digitNumbers = cleaned.match(/\d+\.?\d*/g);
  if (digitNumbers?.length >= 2) {
    // Simple addition/subtraction with digit numbers
    const nums = digitNumbers.map(Number);
    if (cleaned.toLowerCase().includes('add') || cleaned.toLowerCase().includes('total') || cleaned.toLowerCase().includes('sum') || cleaned.toLowerCase().includes('plus')) {
      return nums.reduce((a, b) => a + b, 0);
    }
    if (cleaned.toLowerCase().includes('subtract') || cleaned.toLowerCase().includes('minus') || cleaned.toLowerCase().includes('difference')) {
      return nums[0] - nums.slice(1).reduce((a, b) => a + b, 0);
    }
    if (cleaned.toLowerCase().includes('multiply') || cleaned.toLowerCase().includes('times') || cleaned.toLowerCase().includes('product')) {
      return nums.reduce((a, b) => a * b, 1);
    }
    // Default: addition for "total" / "what is"
    return nums.reduce((a, b) => a + b, 0);
  }

  // Try word-based numbers
  const lc = cleaned.toLowerCase();

  // Extract patterns like "X is [number words] and ... adds/plus [number words]"
  const numberWordPattern = /(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)[\s-]*/gi;

  // Find number word sequences
  const numberSequences = [];
  let match;
  const wordRegex = /(?:(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)[\s-]*)+/gi;
  while ((match = wordRegex.exec(lc)) !== null) {
    const num = wordsToNumber(match[0]);
    if (num > 0) numberSequences.push(num);
  }

  if (numberSequences.length >= 2) {
    if (lc.includes('add') || lc.includes('total') || lc.includes('sum') || lc.includes('plus')) {
      return numberSequences.reduce((a, b) => a + b, 0);
    }
    if (lc.includes('subtract') || lc.includes('minus') || lc.includes('difference')) {
      return numberSequences[0] - numberSequences.slice(1).reduce((a, b) => a + b, 0);
    }
    if (lc.includes('multiply') || lc.includes('times') || lc.includes('product')) {
      return numberSequences.reduce((a, b) => a * b, 1);
    }
    // Default: addition
    return numberSequences.reduce((a, b) => a + b, 0);
  }

  return null;
}

/**
 * Solve using AI interpretation
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
  await new Promise((resolve, reject) => {
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
 * Prefers AI (handles obfuscation reliably), falls back to regex if no AI provider
 * @param {string} challengeText - The obfuscated challenge text
 * @param {{ providerId?: string, model?: string }} [aiConfig] - Optional AI provider config
 * @returns {string|null} Answer formatted with 2 decimal places, or null if unsolvable
 */
export async function solveChallenge(challengeText, aiConfig) {
  console.log(`🔐 Solving challenge: "${challengeText.substring(0, 80)}..."`);

  // Try AI first — handles obfuscation much better than regex
  const aiAnswer = await solveWithAI(challengeText, aiConfig).catch(err => {
    console.log(`🔐 AI solver error: ${err.message}`);
    return null;
  });
  if (aiAnswer !== null) {
    const formatted = aiAnswer.toFixed(2);
    console.log(`🔐 AI solver: ${formatted}`);
    return formatted;
  }

  // Fall back to regex (works when numbers aren't heavily obfuscated)
  console.log(`🔐 AI unavailable, trying regex solver...`);
  const regexAnswer = solveWithRegex(challengeText);
  if (regexAnswer !== null) {
    const formatted = regexAnswer.toFixed(2);
    console.log(`🔐 Regex solver: ${formatted}`);
    return formatted;
  }

  console.error(`❌ Could not solve Moltbook challenge`);
  return null;
}
