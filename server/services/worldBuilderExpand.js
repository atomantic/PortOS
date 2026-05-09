/**
 * World Builder — LLM expansion.
 *
 * Takes a starter prompt like:
 *   "moebius and scavengers reign meets Prophet inspired sci fi universe"
 * and asks the chosen LLM to return a structured JSON blob:
 *   { stylePrompt, negativePrompt, categories: { landscapes: { variations: [{ label, prompt }] }, ... } }
 *
 * The LLM choice is per-call: caller passes { providerId, model }. If
 * either is missing we fall back to the active provider / its default
 * model so the UI still works for users who haven't configured a stage.
 */

import { executeApiRun, executeCliRun, createRun } from './runner.js';
import { getActiveProvider, getProviderById } from './providers.js';
import { WORLD_CATEGORIES, PROMPT_FRAGMENT_MAX, VARIATIONS_PER_CATEGORY_MAX } from './worldBuilder.js';

const LABEL_MAX = 80;

const EXPANSION_PROMPT = `You are a world-building prompt engineer for a Stable-Diffusion-style image generation pipeline. You will turn the user's starter idea into a structured prompt set that produces a visually consistent universe across many renders.

# Starter idea
{starterPrompt}

# Output contract
Return a SINGLE JSON object. NO markdown, NO commentary. The object MUST have these top-level keys:

- stylePrompt:    string. A single comma-separated style fragment (lighting, color palette, render quality, artist references) that will be PREFIXED to every variation prompt. Keep under 400 characters. No subject nouns — those go in variations.
- negativePrompt: string. Comma-separated tokens to avoid (e.g. "blurry, lowres, watermark, extra fingers"). Tailor to the world's aesthetic.
- categories: object with these EXACT keys:
${WORLD_CATEGORIES.map((c) => `    - ${c}`).join('\n')}

Each category value is an object: { "variations": [...] }
Each variation is { "label": string (max 80 chars), "prompt": string (max 400 chars, comma-separated tokens describing ONE specific subject in this category) }

# Rules
- Generate 6-10 variations per category. They must be visually distinct from each other but stylistically consistent with the world.
- "label" is a short name a human can recognize (e.g. "Crystalline canyon basin", "Scavenger walker mech").
- "prompt" describes the SUBJECT only — the stylePrompt is automatically prepended at render time, so do NOT repeat style tokens in each variation.
- Do not include camera/aspect tokens; the renderer adds those.
- Ground the world in the references provided. If the starter mentions specific artists, comics, films, games, or moods, weave them into stylePrompt.
- Output JUST the JSON object. No prose before or after.`;

const isCliProvider = (provider) => provider?.type === 'cli';

// Awaiting createRun separately keeps the Promise executor synchronous —
// an `async` executor body silently swallows rejected awaits, leaving the
// caller's Promise hanging forever if createRun throws.
async function callLLM(provider, model, prompt) {
  const { runId } = await createRun({
    providerId: provider.id,
    model,
    prompt,
    source: 'world-builder-expansion',
  });
  return new Promise((resolve, reject) => {
    let text = '';
    // Both executeCliRun / executeApiRun are async — they can reject before
    // onComplete ever fires (ensureDir/read/write failures, toolkit not
    // initialized, provider errors). Without a rejection handler the awaiter
    // would hang forever and Node would log an unhandledRejection. Forward
    // the rejection through `reject` so callLLM() always settles.
    if (isCliProvider(provider)) {
      executeCliRun(
        runId,
        provider,
        prompt,
        process.cwd(),
        (chunk) => { text += chunk; },
        (result) => {
          if (result?.error || result?.success === false) {
            reject(new Error(result?.error || 'CLI execution failed'));
          } else {
            resolve(text);
          }
        },
        provider.timeout ?? 300000,
      ).catch(reject);
    } else {
      executeApiRun(
        runId,
        provider,
        model,
        prompt,
        process.cwd(),
        [],
        (data) => { text += typeof data === 'string' ? data : (data?.text || ''); },
        (result) => {
          if (result?.error) reject(new Error(result.error));
          else resolve(text);
        },
      ).catch(reject);
    }
  });
}

const extractJson = (raw) => {
  if (!raw || typeof raw !== 'string') throw new Error('Empty LLM response');
  let s = raw.trim();
  // Strip ```json fences if present.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  // Extract the first complete brace-balanced { … } block — guards against
  // preamble ("Here is…") and trailing junk after the JSON object. The scan
  // is string-aware so braces inside JSON string values (e.g. a prompt that
  // contains "{" or "}") don't unbalance the depth counter.
  const start = s.indexOf('{');
  if (start !== -1) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let i = start; i < s.length; i += 1) {
      const ch = s[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end !== -1) s = s.slice(start, end + 1);
  }
  return JSON.parse(s);
};

const normalizeCategories = (raw) => {
  // The LLM occasionally returns variations as a flat array of strings or
  // skips the wrapping `{ variations: [...] }` object. Coerce both shapes
  // here so the world template stays consistent.
  const out = {};
  for (const key of WORLD_CATEGORIES) {
    const node = raw?.[key];
    let variations = [];
    if (Array.isArray(node)) variations = node;
    else if (Array.isArray(node?.variations)) variations = node.variations;
    out[key] = {
      // Clamp to the same per-category cap the route schema enforces (50)
      // so a runaway LLM response can't bloat /expand output.
      variations: variations.slice(0, VARIATIONS_PER_CATEGORY_MAX).map((v) => {
        if (typeof v === 'string') {
          const trimmed = v.trim();
          return {
            label: trimmed.slice(0, LABEL_MAX),
            prompt: trimmed.slice(0, PROMPT_FRAGMENT_MAX),
          };
        }
        const label = typeof v?.label === 'string' ? v.label.trim().slice(0, LABEL_MAX) : '';
        const prompt = typeof v?.prompt === 'string' ? v.prompt.trim().slice(0, PROMPT_FRAGMENT_MAX) : '';
        return { label, prompt };
      }).filter((v) => v.label && v.prompt),
    };
  }
  return out;
};

/**
 * Expand a starter prompt into a structured world template draft.
 * Returns { stylePrompt, negativePrompt, categories, llm: { provider, model } }.
 *
 * @param {object} options
 * @param {string} options.starterPrompt
 * @param {string} [options.providerId]   — optional override; falls back to active.
 * @param {string} [options.model]        — optional override; falls back to provider default.
 */
export async function expandWorldTemplate({ starterPrompt, providerId, model } = {}) {
  if (!starterPrompt || !starterPrompt.trim()) {
    throw new Error('starterPrompt is required');
  }

  let provider = providerId ? await getProviderById(providerId).catch(() => null) : null;
  if (!provider) provider = await getActiveProvider();
  if (!provider) throw new Error('No AI provider available for world expansion');
  const selectedModel = model || provider.defaultModel || provider.models?.[0];

  const fullPrompt = EXPANSION_PROMPT.replace('{starterPrompt}', starterPrompt.trim());
  console.log(`🌍 World Builder expanding via ${provider.name}/${selectedModel || 'default'}`);

  const raw = await callLLM(provider, selectedModel, fullPrompt);
  const parsed = extractJson(raw);

  const stylePrompt = typeof parsed.stylePrompt === 'string'
    ? parsed.stylePrompt.trim().slice(0, PROMPT_FRAGMENT_MAX) : '';
  const negativePrompt = typeof parsed.negativePrompt === 'string'
    ? parsed.negativePrompt.trim().slice(0, PROMPT_FRAGMENT_MAX) : '';
  const categories = normalizeCategories(parsed.categories || {});
  const totalVariations = WORLD_CATEGORIES.reduce((n, k) => n + (categories[k]?.variations?.length || 0), 0);
  console.log(`🌍 World Builder expansion complete — ${totalVariations} variations across ${WORLD_CATEGORIES.length} categories`);

  return {
    stylePrompt,
    negativePrompt,
    categories,
    llm: { provider: provider.id, model: selectedModel || null },
  };
}

// Export for tests.
export const __testing = { extractJson, normalizeCategories, EXPANSION_PROMPT };
