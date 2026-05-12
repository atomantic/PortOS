/**
 * World Builder — LLM expansion.
 *
 * Takes a starter prompt like:
 *   "moebius and scavengers reign meets Prophet inspired sci fi universe"
 * and asks the chosen LLM to return a structured JSON blob:
 *   { stylePrompt, negativePrompt, categories: { ... }, compositeSheets: [{ kind, label, prompt }] }
 *
 * The LLM choice is per-call: caller passes { providerId, model }. If
 * either is missing we fall back to the active provider / its default
 * model so the UI still works for users who haven't configured a stage.
 */

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
import { extractJson as extractJsonShared } from '../lib/jsonExtract.js';
import { providerHonorsModelOverride, runPromptThroughProvider } from '../lib/promptRunner.js';

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
- compositeSheets: array. Complete, ready-to-render composite board prompts. Each item has { "kind": "reference_sheet" | "world_pitch_poster", "label": string, "prompt": string up to 4000 chars }. These are NOT atomic fragments; each prompt must describe one complete board/poster that combines multiple buckets into a single image.

Each category value is an object containing a "variations" array. Each variation has the shape { "label": string (max 80 chars), "prompt": string (max 400 chars, comma-separated tokens describing ONE specific subject in this category) }. Concrete example for one category:
    "landscapes": { "variations": [
      { "label": "Crystalline canyon basin", "prompt": "vast crystalline canyon, salt flats, low horizon" },
      { "label": "Scrap-iron dune sea", "prompt": "rolling dunes of rusted scrap, half-buried machinery" }
    ] }
Do NOT use \`[...]\`, \`…\`, or any other placeholder/elision tokens — every array MUST contain real variation objects.

Concrete compositeSheets examples:
    { "kind": "reference_sheet", "label": "Gas-Giant Drifters costume sheet", "prompt": "Create a clean illustrated costume reference sheet for Gas-Giant Drifters, a human colony living on floating platforms and balloon settlements high in a gas giant atmosphere. Show a simplified character lineup with five figures: kite child, storm scout, main hero, sky elder, and rig worker. Include material swatches for sailcloth, balloon-skin, rubberized algae fabric, salvaged foil, flex-ceramic patches, storm-glass lenses, braided tether cord, and copper wire ornament. Include fastener/accessory icons for buckles, spring clips, pressure rings, carabiner hooks, breathing collar, goggles, tether belt, strapped sky boots, and wind streamer tabs. Include a color strip: storm blue, saffron, hot coral, orange, slate gray, cream, electric cyan, copper, cloud white. Minimal readable layout, elegant negative space, light background hints of balloon platforms and storm clouds, not baroque, not hyper-detailed." }
    { "kind": "world_pitch_poster", "label": "World summary concept pitch poster", "prompt": "Create a cinematic world summary concept pitch poster for the whole setting. Use an editorial art-board layout: one dominant hero panorama showing the signature world location, several smaller inset environment and culture images, a small creature/species lineup, visual-language thumbnails, color palette strip, material/texture swatches, light-and-atmosphere notes, and theme icons. Include large title typography and a short subtitle/logline area, plus readable section headers such as The World, The Feel, Aesthetic, Environments, Cultures, Tone, Color Palette, Materials & Textures, and Light & Atmosphere. Keep body copy as short graphic blocks, not dense paragraphs. The poster should feel like a concept pitch board for a film/series/game, with clear hierarchy, elegant negative space, and cohesive art direction." }

# Rules
- Generate 5-12 categories total, choosing the buckets that serve the starter idea. Generate 4-10 variations per category. They must be visually distinct from each other but stylistically consistent with the world.
- Generate 3-8 compositeSheets when the starter idea involves clothing systems, colonies, factions, cultures, species, vehicles, settlements, props, posters, decks, or other grouped visual-design systems.
- For broad world/universe/story settings, always include 1-3 "world_pitch_poster" compositeSheets in addition to any "reference_sheet" boards. These are summary concept pitch posters, not atomic character or environment sheets.
- "label" is a short name a human can recognize (e.g. "Crystalline canyon basin", "Scavenger walker mech").
- "prompt" describes the SUBJECT only — the stylePrompt is automatically prepended at render time, so do NOT repeat style tokens in each variation.
- Do not include camera/aspect tokens; the renderer adds those.
- Ground the world in the references provided. If the starter mentions specific artists, comics, films, games, or moods, weave them into stylePrompt.
- If the user asks for style sheets, reference sheets, clothing guides, materials, colonies, factions, tribes, species, pirate/raider groups, world summary boards, concept pitch posters, or pitch-deck posters, create specific categories for the atomic facts AND create compositeSheets for the complete boards.
- For colony clothing systems, include functional details like fasteners, closures, textile/material logic, silhouettes, class/role markers, weather or pressure adaptations, and culturally specific ornamentation.
- Reference-sheet prompts must include a clear board structure: title/subject, 4-6 figure lineup roles when relevant, materials swatches, fasteners/accessories icons, color palette strip, background hint, and simplicity constraints such as minimal readable layout, fewer tiny objects, clean silhouettes, not baroque, not hyper-detailed.
- World pitch poster prompts must include a clear editorial poster structure: world title/subtitle/logline area, dominant hero panorama, inset environment/culture/creature images, visual-language strip, color palette, materials/textures, light/atmosphere, themes/icons, and concise labeled blocks for world, feel, aesthetic, environments, cultures, and tone. Mention that body copy should be short, clean, and readable; avoid dense tiny text.
- If the world needs pitch posters, do not put "text" in the negativePrompt. Prefer "watermark, logo, unreadable tiny text, text artifacts" so title/section typography remains possible.
- Output JUST the JSON object. No prose before or after.`;

// Prefer a block that *looks like* a world-expansion response (has any of
// stylePrompt / negativePrompt / categories / compositeSheets at the top
// level). The expansion prompt includes literal JSON examples like
//   { "label": "Crystalline canyon basin", "prompt": "…" }
// which parse cleanly but aren't the response. Without the shape preference
// we'd return that first valid-but-wrong object and end up with 0 variations.
const isExpansionShape = (o) => o && typeof o === 'object'
  && (typeof o.stylePrompt === 'string'
    || typeof o.negativePrompt === 'string'
    || (o.categories && typeof o.categories === 'object')
    || Array.isArray(o.compositeSheets));

const extractJson = (raw) => {
  // Empty input is a "client-side" oversight (no LLM output at all) — keep
  // the original raw Error so callers / tests that key on the message
  // continue to match. Down-stream JSON parse failures are wrapped in a
  // typed 502 ServerError so the route layer surfaces a useful HTTP code.
  if (!raw || typeof raw !== 'string') throw new Error('Empty LLM response');
  const { value, lastError, lastPreview } = extractJsonShared(raw, {
    shapePredicate: isExpansionShape,
  });
  if (value !== undefined) return value;
  throw new ServerError(
    'LLM returned invalid JSON for world expansion. Try a different model or rerun.',
    {
      status: 502,
      code: 'LLM_INVALID_JSON',
      context: { details: { reason: lastError?.message || 'no JSON object found', preview: lastPreview || '' } },
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
  // Mirror the gate that promptRunner applies internally so the log line
  // and the returned `llm.model` field reflect what'll actually execute.
  // Non-codex CLI providers ignore the per-call model.
  const selectedModel = providerHonorsModelOverride(provider)
    ? (model || provider.defaultModel || provider.models?.[0])
    : (provider.defaultModel || provider.models?.[0]);

  const fullPrompt = EXPANSION_PROMPT.replace('{starterPrompt}', starterPrompt.trim());
  console.log(`🌍 World Builder expanding via ${provider.name}/${selectedModel || 'default'}`);

  // runId is logged so a user debugging an empty expansion can find the
  // raw stdout at data/runs/<runId>/output.txt.
  const { text: raw, runId } = await runPromptThroughProvider({
    provider,
    model: selectedModel,
    prompt: fullPrompt,
    source: 'world-builder-expansion',
  });
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
