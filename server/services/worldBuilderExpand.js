/**
 * World Builder — LLM expansion.
 *
 * Takes a starter prompt like:
 *   "moebius and scavengers reign meets Prophet inspired sci fi universe"
 * and asks the chosen LLM to return a structured JSON blob:
 *   { stylePrompt, negativePrompt, categories: { ... }, compositeSheets: [{ label, prompt }] }
 *
 * The LLM choice is per-call: caller passes { providerId, model }. If
 * either is missing we fall back to the active provider / its default
 * model so the UI still works for users who haven't configured a stage.
 */

import { executeApiRun, executeCliRun, createRun } from './runner.js';
import { getActiveProvider, getProviderById } from './providers.js';
import {
  WORLD_CATEGORIES,
  PROMPT_FRAGMENT_MAX,
  COMPOSITE_PROMPT_MAX,
  VARIATIONS_PER_CATEGORY_MAX,
  sanitizeCategories,
  sanitizeCompositeSheets,
} from './worldBuilder.js';
import { ServerError } from '../lib/errorHandler.js';

const LABEL_MAX = 80;

const EXPANSION_PROMPT = `You are a world-building prompt engineer for a Stable-Diffusion-style image generation pipeline. You will turn the user's starter idea into a structured prompt set that produces a visually consistent universe across many renders.

# Starter idea
{starterPrompt}

# Output contract
Return a SINGLE JSON object. NO markdown, NO commentary. The object MUST have these top-level keys:

- stylePrompt:    string. A single comma-separated style fragment (lighting, color palette, render quality, artist references) that will be PREFIXED to every variation prompt. Keep under 400 characters. No subject nouns — those go in variations.
- negativePrompt: string. Comma-separated tokens to avoid (e.g. "blurry, lowres, watermark, extra fingers"). Tailor to the world's aesthetic.
- categories: object. Atomic reusable buckets. Use snake_case keys. Start from these common buckets when useful:
${WORLD_CATEGORIES.map((c) => `    - ${c}`).join('\n')}
  Add, remove, or rename buckets to fit the user's actual world-building task. Do not force every project into the starter buckets.
  Useful extra buckets include colonies, factions, tribes, species, cultures, clothing_styles, material_palettes, fasteners_and_closures, tools, rituals, raider_clans, vehicles, settlements, and artifacts.
- compositeSheets: array. Complete, ready-to-render reference-board prompts. Each item has { "label": string, "prompt": string up to 4000 chars }. These are NOT atomic fragments; each prompt must describe one complete sheet that combines multiple buckets into a single image.

Each category value is an object containing a "variations" array. Each variation has the shape { "label": string (max 80 chars), "prompt": string (max 400 chars, comma-separated tokens describing ONE specific subject in this category) }. Concrete example for one category:
    "landscapes": { "variations": [
      { "label": "Crystalline canyon basin", "prompt": "vast crystalline canyon, salt flats, low horizon" },
      { "label": "Scrap-iron dune sea", "prompt": "rolling dunes of rusted scrap, half-buried machinery" }
    ] }
Do NOT use \`[...]\`, \`…\`, or any other placeholder/elision tokens — every array MUST contain real variation objects.

Concrete compositeSheets example:
    { "label": "Gas-Giant Drifters costume sheet", "prompt": "Create a clean illustrated costume reference sheet for Gas-Giant Drifters, a human colony living on floating platforms and balloon settlements high in a gas giant atmosphere. Show a simplified character lineup with five figures: kite child, storm scout, main hero, sky elder, and rig worker. Include material swatches for sailcloth, balloon-skin, rubberized algae fabric, salvaged foil, flex-ceramic patches, storm-glass lenses, braided tether cord, and copper wire ornament. Include fastener/accessory icons for buckles, spring clips, pressure rings, carabiner hooks, breathing collar, goggles, tether belt, strapped sky boots, and wind streamer tabs. Include a color strip: storm blue, saffron, hot coral, orange, slate gray, cream, electric cyan, copper, cloud white. Minimal readable layout, elegant negative space, light background hints of balloon platforms and storm clouds, not baroque, not hyper-detailed." }

# Rules
- Generate 5-12 categories total, choosing the buckets that serve the starter idea. Generate 4-10 variations per category. They must be visually distinct from each other but stylistically consistent with the world.
- Generate 3-8 compositeSheets when the starter idea involves clothing systems, colonies, factions, cultures, species, vehicles, settlements, props, or other grouped visual-design systems.
- "label" is a short name a human can recognize (e.g. "Crystalline canyon basin", "Scavenger walker mech").
- "prompt" describes the SUBJECT only — the stylePrompt is automatically prepended at render time, so do NOT repeat style tokens in each variation.
- Do not include camera/aspect tokens; the renderer adds those.
- Ground the world in the references provided. If the starter mentions specific artists, comics, films, games, or moods, weave them into stylePrompt.
- If the user asks for style sheets, reference sheets, clothing guides, materials, colonies, factions, tribes, species, or pirate/raider groups, create specific categories for the atomic facts AND create compositeSheets for the complete boards.
- For colony clothing systems, include functional details like fasteners, closures, textile/material logic, silhouettes, class/role markers, weather or pressure adaptations, and culturally specific ornamentation.
- Composite sheet prompts must include a clear board structure: title/subject, 4-6 figure lineup roles, materials swatches, fasteners/accessories icons, color palette strip, background hint, and simplicity constraints such as minimal readable layout, fewer tiny objects, clean silhouettes, not baroque, not hyper-detailed.
- Output JUST the JSON object. No prose before or after.`;

const isCliProvider = (provider) => provider?.type === 'cli';

// Awaiting createRun separately keeps the Promise executor synchronous —
// an `async` executor body silently swallows rejected awaits, leaving the
// caller's Promise hanging forever if createRun throws.
// Returns { text, runId } — runId is logged so a user debugging an empty
// expansion can find the raw stdout at data/runs/<runId>/output.txt.
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
            resolve({ text, runId });
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
          else resolve({ text, runId });
        },
      ).catch(reject);
    }
  });
}

// Walk the string and return every top-level brace-balanced { … } block, in
// order. String-aware so braces inside JSON string values don't throw off the
// depth counter. Used by extractJson — Codex CLI echoes the user prompt back
// to stdout before the model response, and the prompt itself contains a
// JSON-shaped *schema example* (e.g. `{ "label": string (max 80 chars), … }`)
// whose braces balance but whose contents are not valid JSON. Returning every
// block lets the caller try each in turn instead of giving up on the first.
const findBalancedBlocks = (s) => {
  const blocks = [];
  let i = 0;
  while (i < s.length) {
    const start = s.indexOf('{', i);
    if (start === -1) break;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let j = start; j < s.length; j += 1) {
      const ch = s[j];
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
        if (depth === 0) { end = j; break; }
      }
    }
    if (end === -1) break; // unbalanced — no later block can balance either
    blocks.push(s.slice(start, end + 1));
    i = end + 1;
  }
  return blocks;
};

// Try JSON.parse on a candidate block; if it fails, attempt a few cheap
// repairs that handle observed LLM corruption patterns:
//   - Codex CLI sometimes emits an EXTRA `}` between a variation's close-brace
//     and its enclosing array's `]` (`}}]}}}` instead of `}]}}}`). Brace
//     balance still works because the extra `{` was hallucinated upstream.
//   - Trailing comma before `]` or `}`.
// We try removing/normalizing one suspicious char at a time, capped at a few
// attempts so a genuinely broken block still bubbles a parse error.
const tryParseWithRepair = (block) => {
  try { return { value: JSON.parse(block) }; } catch (initialErr) {
    // Remove trailing commas before `}` or `]` (common LLM mistake).
    let candidate = block.replace(/,(\s*[}\]])/g, '$1');
    if (candidate !== block) {
      try { return { value: JSON.parse(candidate) }; } catch { /* keep trying */ }
    }
    // Fix Codex's `}}]` → `}]}` pattern: the variation object closes
    // correctly, then an orphan `}` lands BEFORE the array's `]` instead of
    // after it. Swapping (not dropping) keeps the brace count correct so the
    // outer container still closes — dropping the brace would leave a
    // dangling object open further out.
    candidate = candidate.replace(/}\s*}\s*]/g, '}]}');
    try { return { value: JSON.parse(candidate) }; } catch (err) {
      return { error: err };
    }
  }
};

const extractJson = (raw) => {
  if (!raw || typeof raw !== 'string') throw new Error('Empty LLM response');
  let s = raw.trim();
  // Strip ```json fences if present.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  // Try each brace-balanced block in order. This skips preamble ("Here is…"),
  // prompt echoes (Codex CLI), and pseudo-JSON schema examples in the prompt.
  // We prefer a block that *looks like* a world-expansion response (has any of
  // stylePrompt / negativePrompt / categories at the top level) — the prompt
  // template includes small JSON examples like
  //   { "label": "Crystalline canyon basin", "prompt": "…" }
  // which parse cleanly but aren't the response. Without the shape preference
  // we'd return that first valid-but-wrong object and end up with 0 variations.
  const candidates = findBalancedBlocks(s);
  if (!candidates.length) candidates.push(s);
  const isExpansionShape = (o) => o && typeof o === 'object'
    && (typeof o.stylePrompt === 'string' || typeof o.negativePrompt === 'string' || (o.categories && typeof o.categories === 'object') || Array.isArray(o.compositeSheets));
  let firstParsed;
  let lastErr;
  let lastPreview = s;
  for (const block of candidates) {
    // Recovery: some LLMs (notably Codex CLI) echo the prompt's `[...]`
    // schema-notation back as a literal value. Replace such empty-placeholder
    // arrays with `[]` so the rest of the parse can succeed.
    const cleaned = block.replace(/\[\s*\.\.\.\s*\]/g, '[]');
    const { value: parsed, error } = tryParseWithRepair(cleaned);
    if (parsed !== undefined) {
      if (isExpansionShape(parsed)) return parsed;
      if (firstParsed === undefined) firstParsed = parsed;
    } else {
      lastErr = error;
      lastPreview = cleaned;
    }
  }
  if (firstParsed !== undefined) return firstParsed;
  throw new ServerError(
    'LLM returned invalid JSON for world expansion. Try a different model or rerun.',
    {
      status: 502,
      code: 'LLM_INVALID_JSON',
      context: { details: { reason: lastErr?.message || 'no JSON object found', preview: lastPreview.slice(0, 200) } },
    },
  );
};

const normalizeCategories = (raw) => {
  // The LLM occasionally returns variations as a flat array of strings or
  // skips the wrapping `{ variations: [...] }` object. Coerce both shapes
  // here so the world template stays consistent. Preserve custom buckets
  // (e.g. colonies, factions, clothing_styles) instead of forcing everything
  // into the starter categories.
  const out = {};
  const rawEntries = raw && typeof raw === 'object' ? Object.entries(raw) : [];
  for (const [key, node] of rawEntries) {
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
  return sanitizeCategories(out);
};

const normalizeCompositeSheets = (raw) => sanitizeCompositeSheets(
  Array.isArray(raw)
    ? raw.map((sheet) => {
      if (typeof sheet === 'string') {
        const trimmed = sheet.trim();
        return { label: trimmed.slice(0, LABEL_MAX), prompt: trimmed.slice(0, COMPOSITE_PROMPT_MAX) };
      }
      return sheet;
    })
    : [],
);

/**
 * Expand a starter prompt into a structured world template draft.
 * Returns { stylePrompt, negativePrompt, categories, compositeSheets, llm: { provider, model } }.
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

  const { text: raw, runId } = await callLLM(provider, selectedModel, fullPrompt);
  // Log raw response shape so a "0 variations" outcome is debuggable from
  // the server console alone — the runId points at data/runs/<id>/output.txt
  // for the full transcript.
  console.log(`🌍 World Builder raw response — runId=${runId} length=${raw?.length || 0}`);
  const parsed = extractJson(raw);
  console.log(`🌍 World Builder parsed JSON — keys=[${Object.keys(parsed || {}).join(',')}] categoryKeys=[${Object.keys(parsed?.categories || {}).join(',')}] compositeSheets=${Array.isArray(parsed?.compositeSheets) ? parsed.compositeSheets.length : 0}`);

  const stylePrompt = typeof parsed.stylePrompt === 'string'
    ? parsed.stylePrompt.trim().slice(0, PROMPT_FRAGMENT_MAX) : '';
  const negativePrompt = typeof parsed.negativePrompt === 'string'
    ? parsed.negativePrompt.trim().slice(0, PROMPT_FRAGMENT_MAX) : '';
  const categories = normalizeCategories(parsed.categories || {});
  const compositeSheets = normalizeCompositeSheets(parsed.compositeSheets || []);
  const perCat = Object.keys(categories).map((k) => `${k}=${categories[k]?.variations?.length || 0}`).join(' ');
  const totalVariations = Object.values(categories).reduce((n, c) => n + (c?.variations?.length || 0), 0);
  console.log(`🌍 World Builder expansion complete — runId=${runId} ${totalVariations} variations, ${compositeSheets.length} composite sheets (${perCat})`);
  if (totalVariations === 0 && compositeSheets.length === 0) {
    console.warn(`⚠️ World Builder expansion produced 0 variations — inspect data/runs/${runId}/output.txt for the raw LLM response`);
  }

  return {
    stylePrompt,
    negativePrompt,
    categories,
    compositeSheets,
    llm: { provider: provider.id, model: selectedModel || null },
  };
}

// Export for tests.
export const __testing = { extractJson, normalizeCategories, normalizeCompositeSheets, EXPANSION_PROMPT };
