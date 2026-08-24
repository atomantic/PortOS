/**
 * Universe Builder — LLM expansion.
 *
 * Takes a starter prompt like:
 *   "moebius and scavengers reign meets Prophet inspired sci fi universe"
 * and asks the chosen LLM to return a structured JSON blob:
 *   { influences: { embrace, avoid }, categories: { ... }, compositeSheets: [{ kind, label, prompt }] }
 *
 * The LLM choice is per-call: caller passes { providerId, model, effort }. If
 * provider/model is missing we fall back to the active provider / its default
 * model so the UI still works for users who haven't configured a stage.
 */

import {
  WORLD_CATEGORIES,
  CATEGORY_KINDS,
  LOCKABLE_FIELDS,
  LOCKABLE_FIELD_LABELS,
  PROMPT_FRAGMENT_MAX,
  COMPOSITE_PROMPT_MAX,
  VARIATIONS_PER_CATEGORY_MAX,
  LOGLINE_MAX,
  PREMISE_MAX,
  STYLE_NOTES_MAX,
  buildUniverseStyleContext,
  isInfluenceLockField,
  normalizeCategoryKey,
  sanitizeCategories,
  sanitizeCompositeSheets,
  sanitizeInfluences,
} from "./universeBuilder.js";
import { sanitizeBibleList, stripCanonControlFields, BIBLE_KIND, BIBLE_SOURCE } from "../lib/storyBible.js";
import { ServerError } from "../lib/errorHandler.js";
import { extractJson as extractJsonShared } from "../lib/jsonExtract.js";
import { isPlainObject } from "../lib/objects.js";
import {
  assertProvider,
  resolveProviderAndModel,
  runPromptThroughProvider,
} from "./promptRunner.js";

const LABEL_MAX = 80;
const NARRATIVE_REPAIR_MAX_ATTEMPTS = 3;
const NARRATIVE_REPAIR_HEADROOM = [0.9, 0.8];

// A judge-directed narrative repair must ADD material — an operational ruleset,
// a missing cost, a named hard limit — to a bible field that EARLIER repairs may
// already have filled to its storage ceiling. Enforcing only the hard cap made
// that unsatisfiable: with a premise sitting at 19,995 of 20,000 characters
// there is no room for the rules the judge asked for, so the model returned a
// same-size rewrite, the field passed validation (it was under the cap), the
// foundation judge re-read an unchanged world, scored it identically, and the
// autopilot's foundation gate burned every round on a repair that could not
// physically land. Saturated fields therefore get a WRITE TARGET below the cap
// plus an explicit consolidate-then-extend mandate, and the storage contract is
// checked against that target — so the existing retry ladder forces the
// consolidation instead of accepting a no-op rewrite.
export const NARRATIVE_REPAIR_WRITE_HEADROOM = 0.85;

// The narrative-bible scalars a foundation repair persists, with their hard
// storage caps. Single source for the write budget, the prompt contract, and
// the violation check so the three can't drift.
const NARRATIVE_FIELD_CAPS = Object.freeze([
  ['logline', LOGLINE_MAX],
  ['premise', PREMISE_MAX],
  ['styleNotes', STYLE_NOTES_MAX],
]);

/**
 * Per-field write budget for a narrative repair, derived from what is ALREADY
 * stored. A field under the headroom mark may use its full cap (nothing to make
 * room for); a saturated one is asked to come back under the headroom target so
 * the repair has somewhere to go. Pure + unit-tested.
 *
 * @returns {Record<string, { max, target, priorLength, saturated }>}
 */
export function narrativeRepairTargets(prior = {}) {
  const targets = {};
  for (const [key, max] of NARRATIVE_FIELD_CAPS) {
    const priorLength = typeof prior?.[key] === 'string' ? prior[key].trim().length : 0;
    const headroomTarget = Math.floor(max * NARRATIVE_REPAIR_WRITE_HEADROOM);
    const saturated = priorLength > headroomTarget;
    targets[key] = { max, priorLength, saturated, target: saturated ? headroomTarget : max };
  }
  return targets;
}

// Bible/prompt fields the LLM sees as "current universe state" so re-expansion
// stays consistent with prior refinements. Derived from LOCKABLE_FIELDS so a
// new lockable field automatically reaches this prompt; excludes starterPrompt
// (already shown above as the seed) and influences (rendered in its own
// section).
const CURRENT_STATE_FIELDS = LOCKABLE_FIELDS
  .filter((k) => k !== 'starterPrompt' && !isInfluenceLockField(k))
  .map((k) => [k, LOCKABLE_FIELD_LABELS[k].toUpperCase()]);

function buildExpansionPrompt({
  starterPrompt,
  influences,
  preservedVariations,
  preservedCompositeSheets,
  narrativeOnly = false,
  // Prior bible state — locked entries echo back unchanged; unlocked entries
  // seed the LLM. Empty/missing fields are skipped.
  priorLogline = '',
  priorPremise = '',
  priorStyleNotes = '',
  locked = {},
  foundationDirective = '',
  writeTargets,
}) {
  const embrace = Array.isArray(influences?.embrace)
    ? influences.embrace.filter(Boolean)
    : [];
  const avoid = Array.isArray(influences?.avoid)
    ? influences.avoid.filter(Boolean)
    : [];
  const embraceTag = locked?.influencesEmbrace ? ' [LOCKED]' : '';
  const avoidTag = locked?.influencesAvoid ? ' [LOCKED]' : '';
  const influencesSection =
    embrace.length || avoid.length
      ? `\n# Influences (style prompt embrace + negative prompt avoid — joined verbatim at render time as the universe's positive + negative prompts)\nEmbrace${embraceTag}: ${embrace.join(", ") || "(none)"}\nAvoid${avoidTag}: ${avoid.join(", ") || "(none)"}\n`
      : "";

  // Locked entries are flagged and MUST be echoed verbatim; unlocked entries
  // are starting points the LLM can refine. Consistency goal: an LLM-generated
  // premise should align with a locked logline, not be written in isolation.
  const priorValues = {
    logline: priorLogline,
    premise: priorPremise,
    styleNotes: priorStyleNotes,
  };
  const stateLines = CURRENT_STATE_FIELDS
    .filter(([key]) => typeof priorValues[key] === 'string' && priorValues[key].trim())
    .map(([key, label]) => `${label}${locked?.[key] ? ' [LOCKED]' : ''}: ${priorValues[key].trim()}`);
  const anyLocked = stateLines.length
    && Object.keys(locked || {}).some((k) => locked[k] === true);
  const currentStateSection = stateLines.length
    ? `\n# Current universe state — established context for this expansion${anyLocked ? '. Fields marked [LOCKED] MUST be echoed unchanged in your output' : ''}.
${stateLines.join('\n\n')}\n`
    : '';
  const safeFoundationDirective = typeof foundationDirective === 'string'
    ? foundationDirective.trim().slice(0, 2_000)
    : '';
  const foundationSection = safeFoundationDirective
    ? `\n# Foundation repair directive\nA whole-series foundation judge found the following concrete weakness. Repair it across the unlocked world-bible fields while preserving every locked field and established fact:\n${safeFoundationDirective}\n`
    : '';

  // Foundation convergence persists only the narrative bible scalars. Asking
  // the normal Universe Builder contract for dozens of image variations,
  // composite sheets, and canon candidates makes the model spend most of its
  // time authoring output this caller must discard. Keep ordinary expansion
  // unchanged, but give judge-directed repairs the narrow contract they can
  // actually apply.
  if (narrativeOnly) {
    // Name the budget the validator will actually enforce. A saturated field
    // also gets its current size, because "write at most N" is not actionable
    // when the model is simultaneously told to preserve an established value
    // that is already larger than N — it has to know consolidation is the job.
    const budgetLine = (key) => {
      const { target, saturated, priorLength } = writeTargets[key];
      return saturated
        ? `max ${target} characters — the established ${key} is already ${priorLength} characters, so the repair CANNOT be appended: consolidate the existing prose under that budget first, then add what the directive requires`
        : `max ${target} characters`;
    };
    const saturatedFields = NARRATIVE_FIELD_CAPS
      .map(([key]) => key)
      .filter((key) => writeTargets[key].saturated);
    const consolidationSection = saturatedFields.length
      ? `\n# Consolidation mandate — ${saturatedFields.join(', ')} ${saturatedFields.length === 1 ? 'is' : 'are'} at the storage ceiling
The repair does not fit alongside the current text, so making room is part of this task, not optional.
- Merge duplicated lore, collapse parallel examples into one precise sentence, and cut ornamental restatement and throat-clearing.
- Never drop a causal rule, hard limit, cost, failure mode, named entity, faction, or site-specific operation to save space — those are the load-bearing content. Cut the prose around them.
- Never truncate: no sentence, paragraph, rule, or list item may end unfinished.
- Silently count characters before answering. A response over budget is rejected in full.\n`
      : '';
    return `You are a senior speculative-fiction worldbuilder repairing the narrative bible for a comic/TV series. This is a focused continuity repair, not a visual-exploration or canon-invention pass.

# Starter idea
${starterPrompt}
${influencesSection}${currentStateSection}${foundationSection}${consolidationSection}
# Output contract
Return one JSON object with exactly these top-level keys and no others:

- logline: string, one sentence (${budgetLine('logline')}).
- premise: string, concise paragraphs (${budgetLine('premise')}) defining the setting, conflict, stakes, and every operational rule needed to satisfy the repair directive.
- styleNotes: string (${budgetLine('styleNotes')}) preserving the established tonal and sensory identity while making any worldbuilding guidance concrete enough for writers to apply.

# Repair rules
- Resolve the judge's exact contradiction or omission. Do not answer it with extra lore that leaves the named causal problem intact.
- State capabilities together with hard limits, exact costs, recharge or recovery conditions, failure modes, information loss, and who pays each price.
- Make the repaired rule exert plot pressure: identify the kinds of choices it forces and the societal, political, economic, or ritual consequences it creates.
- Preserve established facts. Fields marked [LOCKED] must be echoed verbatim. Change an unlocked field only as much as the repair requires.
- Do not emit influences, categories, compositeSheets, characters, places, objects, render prompts, reference boards, or markdown.
- Return only the JSON object. No prose before or after.`;
  }

  // Preserved items: the client extracted user-pinned variations and
  // composite boards. List them by category + label so the LLM can avoid
  // generating duplicates, but tell it explicitly NOT to echo them in its
  // output (the client merges them back in).
  const preservedVariationLines = [];
  if (preservedVariations && typeof preservedVariations === "object") {
    for (const [cat, list] of Object.entries(preservedVariations)) {
      if (!Array.isArray(list) || list.length === 0) continue;
      for (const v of list) {
        if (!v || !v.label) continue;
        preservedVariationLines.push(`- ${cat}: "${v.label}"`);
      }
    }
  }
  const preservedSheetLines = Array.isArray(preservedCompositeSheets)
    ? preservedCompositeSheets
        .filter((s) => s && s.label)
        .map((s) => `- ${s.kind || "reference_sheet"}: "${s.label}"`)
    : [];

  const preservedSection =
    preservedVariationLines.length || preservedSheetLines.length
      ? `\n# Preserved items — DO NOT regenerate these labels (the user has pinned them; the client preserves them on merge)
${preservedVariationLines.length ? `Pinned variations:\n${preservedVariationLines.join("\n")}\n` : ""}${preservedSheetLines.length ? `Pinned composite boards:\n${preservedSheetLines.join("\n")}\n` : ""}`
      : "";

  return `You are a universe-building prompt engineer for a Stable-Diffusion-style image generation pipeline AND a story-bible drafter for a comic/TV production pipeline. You will turn the user's starter idea into (a) a structured prompt set that produces a visually consistent universe across many renders, and (b) a short narrative bible that downstream writing stages can ingest.

# Starter idea
${starterPrompt}
${influencesSection}${currentStateSection}${foundationSection}${preservedSection}
# Output contract
Return a SINGLE JSON object. NO markdown, NO commentary. The object MUST have these top-level keys:

- logline:        string. ONE sentence (≤${LOGLINE_MAX} chars) capturing the universe's central tension/hook — protagonist-agnostic if no protagonist is implied. Example: "A foundry city goes silent — and the only survivor is a child."
- premise:        string. 1-3 short paragraphs (≤${PREMISE_MAX} chars total) describing the setting, the central conflict or situation, the stakes, and the tone. Write it as the elevator pitch a showrunner would hand to a writers' room. No bullet points; prose only.
- styleNotes:     string. A prose paragraph (≤${STYLE_NOTES_MAX} chars) describing the visual + tonal style for the story bible — references (artists, films, comics, games), mood, palette, pacing, narrative voice. This is read by writers + creative directors, not the image model, so use full sentences instead of comma-separated tokens.
- influences:     object { "embrace": [string], "avoid": [string] }. THIS IS THE UNIVERSE'S STYLE + NEGATIVE PROMPT. Each list is a set of short prompt tokens (max 120 chars each, max 30 per list). The "embrace" list is joined verbatim as the positive style prompt prepended to every render (palette, lighting, render quality, artist references — e.g. "moebius linework", "cel-shading", "dust palette"). The "avoid" list is joined verbatim as the negative prompt (e.g. "blurry", "lowres", "watermark", "extra fingers"). Use short token-style labels, NOT full sentences. When influence input is provided above, preserve those entries unless the starter idea explicitly contradicts them.
- characters: array. Named cast members central to this universe. Each item has { "name": string (max 120 chars), "physicalDescription": string (max 1000 chars, what they look like — face, build, age range, distinguishing marks), "personality": string (max 600 chars), "background": string (max 800 chars, where they come from + role in the world), "prompt": string (max 400 chars, the render-prompt fragment used for reference images), "tags": [string] (1-3 short labels like "protagonist", "antagonist", "supporting") }. Generate 0-8 leads. Distinct from category "variations" (which are exploratory render prompts) — these are first-class entities that downstream pipeline stages address by name.
- places: array. Named recurring places in this universe. Each item has { "name": string (max 120 chars, human label like "Foundry City"), "slugline": string (max 120 chars, screenplay-style location header like "EXT. FOUNDRY CITY — DAY"), "description": string (max 1000 chars), "palette": string (max 300 chars, dominant colors), "recurringDetails": string (max 600 chars, recognizable motifs that recur across scenes), "prompt": string (max 400 chars, render-prompt fragment), "tags": [string] }. Generate 0-8 key places.
- objects: array. Named props / vehicles / artifacts with story weight. Each item has { "name": string (max 120 chars), "description": string (max 1000 chars, what it looks like + what it does), "significance": string (max 600 chars, why it matters to the story), "prompt": string (max 400 chars, render-prompt fragment), "tags": [string] }. Generate 0-5 hero objects.
- categories: object. Atomic reusable buckets for VISUAL EXPLORATION — bulk-render N variations to see a range of options. Use snake_case keys. Start from these common buckets when useful:
${WORLD_CATEGORIES.map((c) => `    - ${c}`).join("\n")}
  Add, remove, or rename buckets to fit the user's actual universe-building task. Do not force every project into the starter buckets.
  Useful extra buckets include colonies, factions, tribes, species, cultures, clothing_styles, material_palettes, fasteners_and_closures, tools, rituals, raider_clans, vehicles, settlements, and artifacts.
- compositeSheets: array. Complete, ready-to-render composite board prompts. Each item has { "kind": "reference_sheet" | "world_pitch_poster", "label": string, "prompt": string up to 4000 chars }. These are NOT atomic fragments; each prompt must describe one complete board/poster that combines multiple buckets into a single image.

Each category value is an object with TWO fields: { "kind": one of ${CATEGORY_KINDS.map((k) => `"${k}"`).join(" | ")}, "variations": array }. The "kind" tags which canon trunk the bucket belongs to — use "characters" for buckets of people/groups (factions, tribes, clans), "places" for locations (landscapes, environments, colonies, structures), "objects" for things (vehicles, tools, artifacts), and "other" when nothing else fits. Each variation has the shape { "label": string (max 80 chars), "prompt": string (max 400 chars, comma-separated tokens describing ONE specific subject in this category) }. Concrete example for one category:
    "landscapes": { "kind": "places", "variations": [
      { "label": "Crystalline canyon basin", "prompt": "vast crystalline canyon, salt flats, low horizon" },
      { "label": "Scrap-iron dune sea", "prompt": "rolling dunes of rusted scrap, half-buried machinery" }
    ] }
Do NOT use \`[...]\`, \`…\`, or any other placeholder/elision tokens — every array MUST contain real variation objects.

Canon vs categories: a single named entity belongs in CANON (characters/places/objects) — the protagonist "Ash" goes in characters[], not in a category. A bucket of N exploratory looks belongs in categories — "what could 5 different faction outfit styles look like" goes in a "factions" category with variations[]. The user will iterate on each surface separately.

Concrete compositeSheets examples:
    { "kind": "reference_sheet", "label": "Gas-Giant Drifters costume sheet", "prompt": "Create a clean illustrated costume reference sheet for Gas-Giant Drifters, a human colony living on floating platforms and balloon settlements high in a gas giant atmosphere. Show a simplified character lineup with five figures: kite child, storm scout, main hero, sky elder, and rig worker. Include material swatches for sailcloth, balloon-skin, rubberized algae fabric, salvaged foil, flex-ceramic patches, storm-glass lenses, braided tether cord, and copper wire ornament. Include fastener/accessory icons for buckles, spring clips, pressure rings, carabiner hooks, breathing collar, goggles, tether belt, strapped sky boots, and wind streamer tabs. Include a color strip: storm blue, saffron, hot coral, orange, slate gray, cream, electric cyan, copper, cloud white. Minimal readable layout, elegant negative space, light background hints of balloon platforms and storm clouds, not baroque, not hyper-detailed." }
    { "kind": "world_pitch_poster", "label": "Universe summary concept pitch poster", "prompt": "Create a cinematic universe summary concept pitch poster for the whole setting. Use an editorial art-board layout: one dominant hero panorama showing the signature universe location, several smaller inset environment and culture images, a small creature/species lineup, visual-language thumbnails, color palette strip, material/texture swatches, light-and-atmosphere notes, and theme icons. Include large title typography and a short subtitle/logline area, plus readable section headers such as The Universe, The Feel, Aesthetic, Environments, Cultures, Tone, Color Palette, Materials & Textures, and Light & Atmosphere. Keep body copy as short graphic blocks, not dense paragraphs. The poster should feel like a concept pitch board for a film/series/game, with clear hierarchy, elegant negative space, and cohesive art direction." }

# Rules
- Populate canon with the named entities you'd reference by name in a script. Empty arrays are fine when the starter idea doesn't imply specific characters/places/objects yet.
- Generate 5-12 categories total, choosing the buckets that serve the starter idea. Generate 4-10 variations per category. They must be visually distinct from each other but stylistically consistent with the universe. Tag each category's "kind" so it lands under the right canon trunk in the UI.
- Generate 3-8 compositeSheets when the starter idea involves clothing systems, colonies, factions, cultures, species, vehicles, settlements, props, posters, decks, or other grouped visual-design systems.
- For broad universe/universe/story settings, always include 1-3 "world_pitch_poster" compositeSheets in addition to any "reference_sheet" boards. These are summary concept pitch posters, not atomic character or environment sheets.
- "label" is a short name a human can recognize (e.g. "Crystalline canyon basin", "Scavenger walker mech").
- "prompt" describes the SUBJECT only — the embrace influences are automatically prepended at render time as the style prompt, so do NOT repeat style tokens in each variation.
- Do not include camera/aspect tokens; the renderer adds those.
- Ground the universe in the references provided. If the starter mentions specific artists, comics, films, games, or moods, weave them into the embrace influences.
- If the user asks for style sheets, reference sheets, clothing guides, materials, colonies, factions, tribes, species, pirate/raider groups, universe summary boards, concept pitch posters, or pitch-deck posters, create specific categories for the atomic facts AND create compositeSheets for the complete boards.
- For colony clothing systems, include functional details like fasteners, closures, textile/material logic, silhouettes, class/role markers, weather or pressure adaptations, and culturally specific ornamentation.
- Reference-sheet prompts must include a clear board structure: title/subject, 4-6 figure lineup roles when relevant, materials swatches, fasteners/accessories icons, color palette strip, background hint, and simplicity constraints such as minimal readable layout, fewer tiny objects, clean silhouettes, not baroque, not hyper-detailed.
- Universe pitch poster prompts must include a clear editorial poster structure: universe title/subtitle/logline area, dominant hero panorama, inset environment/culture/creature images, visual-language strip, color palette, materials/textures, light/atmosphere, themes/icons, and concise labeled blocks for universe, feel, aesthetic, environments, cultures, and tone. Mention that body copy should be short, clean, and readable; avoid dense tiny text.
- If the universe needs pitch posters, do not put "text" in the avoid influences. Prefer "watermark", "logo", "unreadable tiny text", "text artifacts" so title/section typography remains possible.
- When "Current universe state" is provided above: treat it as the established universe. Fields marked [LOCKED] MUST be echoed in your output exactly as given — do not reword, expand, or trim them. Unlocked current-state fields are starting points; you may refine them, but stay consistent with locked fields, the starter idea, and influences.

# Worldbuilding craft doctrine (apply to premise + canon — this is what separates a lived-in world from set dressing)
- **Limitations over powers.** What a magic/tech system CAN'T do is more interesting than what it can. Define the hard limits, costs, and rules FIRST; the powers follow.
- **Costs must drive plot, not decorate it.** Every power/technology exacts a price (fuel, blood, memory, time, reputation) that forces hard choices on the page — not flavor text. If a capability has no cost that ever complicates a decision, cut it or give it teeth.
- **Foreshadow before you resolve.** A problem solved using an established rule/power must have shown that rule to the reader earlier. Plant the mechanism before it saves the day, or the resolution reads as a cheat.
- **Iceberg depth.** Imply far more history/culture/systems than you state outright — a few concrete specifics (a saying, a scar, a ruin) signal a deep world without an encyclopedia.
- **Interconnection.** Systems, factions, geography, and economy should link so that pulling one thread visibly moves the others — a drought shifts a faction, which reprices a resource, which pressures the protagonist.
- **Societal implications.** For each major system (magic, tech, resource), name 2–3 concrete downstream effects on daily life, class, law, or belief — who benefits, who is exploited, what taboo or ritual grew up around it.
- **Sensory signature per location.** Give each key place one distinct sensory anchor (a smell, a sound, a quality of light) that recurs so the reader re-enters it instantly.

- Output JUST the JSON object. No prose before or after.`;
}

// Prefer a block that *looks like* a universe-expansion response (has any of
// the top-level keys we expect). The expansion prompt includes literal JSON
// examples like
//   { "label": "Crystalline canyon basin", "prompt": "…" }
// which parse cleanly but aren't the response. Without the shape preference
// we'd return that first valid-but-wrong object and end up with 0 variations.
const isExpansionShape = (o) =>
  o &&
  typeof o === "object" &&
  (typeof o.logline === "string" ||
    typeof o.premise === "string" ||
    typeof o.styleNotes === "string" ||
    (o.influences && typeof o.influences === "object") ||
    (o.categories && typeof o.categories === "object") ||
    Array.isArray(o.compositeSheets) ||
    Array.isArray(o.characters) ||
    Array.isArray(o.places) ||
    Array.isArray(o.objects));

const extractJson = (raw) => {
  // Empty input is a "client-side" oversight (no LLM output at all) — keep
  // the original raw Error so callers / tests that key on the message
  // continue to match. Down-stream JSON parse failures are wrapped in a
  // typed 502 ServerError so the route layer surfaces a useful HTTP code.
  if (!raw || typeof raw !== "string") throw new Error("Empty LLM response");
  const { value, lastError, lastPreview } = extractJsonShared(raw, {
    shapePredicate: isExpansionShape,
  });
  if (value !== undefined) return value;
  throw new ServerError(
    "LLM returned invalid JSON for universe expansion. Try a different model or rerun.",
    {
      status: 502,
      code: "LLM_INVALID_JSON",
      context: {
        details: {
          reason: lastError?.message || "no JSON object found",
          preview: lastPreview || "",
        },
      },
    },
  );
};

const narrativeRepairViolations = (parsed, writeTargets) => NARRATIVE_FIELD_CAPS.flatMap(([key]) => {
  const { target } = writeTargets[key];
  const value = typeof parsed?.[key] === 'string' ? parsed[key].trim() : '';
  if (!value) return [`${key} is missing`];
  return value.length > target ? [`${key} exceeds ${target} characters (got ${value.length})`] : [];
});

const hasCompleteNarrativeCandidate = (candidate) => (
  ['logline', 'premise', 'styleNotes'].every((key) => (
    typeof candidate?.[key] === 'string' && candidate[key].trim()
  ))
);

function buildNarrativeCompressionPrompt({
  candidate, violations, compressionAttempt, writeTargets,
}) {
  const headroom = NARRATIVE_REPAIR_HEADROOM[Math.min(
    compressionAttempt - 1,
    NARRATIVE_REPAIR_HEADROOM.length - 1,
  )];
  // Shrink from the effective WRITE target, not the hard cap — a saturated field
  // is already budgeted below its cap, and compressing to 90% of the cap would
  // hand back a draft that violates the same contract it just failed.
  const targets = Object.fromEntries(NARRATIVE_FIELD_CAPS.map(([key]) => [
    key,
    Math.floor(writeTargets[key].target * headroom),
  ]));
  const source = Object.fromEntries(NARRATIVE_FIELD_CAPS.map(([key]) => [
    key,
    typeof candidate?.[key] === 'string' ? candidate[key].trim() : '',
  ]));
  return `You are a senior story-bible compression editor. Shorten the supplied candidate in place; do not rebuild the world from its original prompt.

# Why this rewrite is required
The candidate failed persistence validation: ${violations.join('; ')}.

# Hard output contract with safety headroom
Return one JSON object with exactly these string keys and no others:
- logline: at most ${targets.logline} characters.
- premise: at most ${targets.premise} characters.
- styleNotes: at most ${targets.styleNotes} characters.

The application rejects the entire response if any field exceeds its target. Aim comfortably below each target and silently count before answering.

# Compression priorities
- Preserve proper nouns, character identities and roles, causal rules, hard limits, costs, failure modes, jurisdictions, and distinct site-specific operations.
- Preserve the setting's conflict, stakes, tone, and every detail that makes a later plot choice possible or constrained.
- Remove repetition, ornamental restatement, redundant examples, and throat-clearing first. Combine parallel rules into precise sentences.
- Do not replace concrete mechanics with vague summary. Do not invent new lore. Do not cut off a sentence, paragraph, rule, or list item.
- Return only valid JSON. No markdown or commentary.

# Candidate to compress
${JSON.stringify(source, null, 2)}`;
}

const normalizeCategories = (raw) => {
  // The LLM occasionally returns variations as a flat array of strings or
  // skips the wrapping `{ variations: [...] }` object. Coerce both shapes
  // here so the universe template stays consistent. Preserve custom buckets
  // (e.g. colonies, factions, clothing_styles) instead of forcing everything
  // into the starter categories.
  const out = {};
  const rawEntries = raw && typeof raw === "object" ? Object.entries(raw) : [];
  for (const [key, node] of rawEntries) {
    let variations = [];
    if (Array.isArray(node)) variations = node;
    else if (Array.isArray(node?.variations)) variations = node.variations;
    // Forward the LLM-returned `kind` (if present + valid) so sanitizeCategory
    // can honor it. Without this passthrough, every custom bucket falls back
    // to the WORLD_CATEGORY_DEFAULT_KINDS map (or `other`), and "kind"-tagged
    // buckets like `factions: { kind: 'characters' }` silently land under the
    // wrong canon trunk in the UI despite the prompt contract advertising it.
    // Clamp invalid LLM values (e.g. "people") at the boundary — drop them so
    // sanitizeCategory falls back to default. sanitizeCategory would clamp
    // again, but doing it here also defends the Zod route schema which
    // rejects unknown enum values on a subsequent save round-trip.
    const llmKind = isPlainObject(node) ? node.kind : undefined;
    const rawKind = CATEGORY_KINDS.includes(llmKind) ? llmKind : undefined;
    out[key] = {
      ...(rawKind !== undefined ? { kind: rawKind } : {}),
      // Clamp to the same per-category cap the route schema enforces (50)
      // so a runaway LLM response can't bloat /expand output.
      variations: variations
        .slice(0, VARIATIONS_PER_CATEGORY_MAX)
        .map((v) => {
          if (typeof v === "string") {
            const trimmed = v.trim();
            return {
              label: trimmed.slice(0, LABEL_MAX),
              prompt: trimmed.slice(0, PROMPT_FRAGMENT_MAX),
            };
          }
          const label =
            typeof v?.label === "string"
              ? v.label.trim().slice(0, LABEL_MAX)
              : "";
          const prompt =
            typeof v?.prompt === "string"
              ? v.prompt.trim().slice(0, PROMPT_FRAGMENT_MAX)
              : "";
          return { label, prompt };
        })
        .filter((v) => v.label && v.prompt),
    };
  }
  return sanitizeCategories(out);
};

const normalizeCompositeSheets = (raw) =>
  sanitizeCompositeSheets(
    Array.isArray(raw)
      ? raw.map((sheet) => {
          if (typeof sheet === "string") {
            const trimmed = sheet.trim();
            return {
              label: trimmed.slice(0, LABEL_MAX),
              prompt: trimmed.slice(0, COMPOSITE_PROMPT_MAX),
            };
          }
          return sheet;
        })
      : [],
  );

// Run an LLM-emitted canon array through the same sanitizer the universe
// service uses on persisted entries, so the merged-into-draft result has
// every required field (id, createdAt, etc.) and survives a round-trip
// through updateUniverse without losing structure. Returns [] for non-arrays
// so the merge step downstream can rely on `Array.isArray`. Stamps `source`
// pre-sanitize so the sanitizer's `ensureSource` allowlist validates it (a
// post-sanitize stamp would bypass that check).
//
// Sanitize an LLM-emitted canon array through the universe service's
// per-kind sanitizer. `source` is stamped pre-sanitize so the sanitizer's
// `ensureSource` allowlist validates it; control fields the LLM should
// never set (id/locked/imageRefs/etc.) are dropped via stripCanonControlFields
// — shared with the Promote path so the two LLM entrypoints can't drift.
const normalizeCanonArray = (raw, kind) => {
  if (!Array.isArray(raw)) return [];
  const stamped = raw.map((e) => {
    if (!e || typeof e !== 'object') return e;
    return { ...stripCanonControlFields(e), source: BIBLE_SOURCE.UNIVERSE_EXPAND };
  });
  return sanitizeBibleList(stamped, kind, { preserveTimestamps: false });
};

/**
 * Expand a starter prompt into a structured universe template draft.
 * Returns { logline, premise, styleNotes, influences, categories, compositeSheets,
 *           characters, places, objects, llm: { provider, model } }.
 *
 * Canon arrays (characters/places/objects) are sanitized through
 * sanitizeBibleList so they're shape-compatible with universe.characters[],
 * universe.places[], universe.objects[] — the client merges them into the
 * draft's canon arrays alongside the category merge.
 *
 * @param {object} options
 * @param {string} options.starterPrompt
 * @param {string} [options.providerId]   — optional override; falls back to active.
 * @param {string} [options.model]        — optional override; falls back to provider default.
 * @param {string} [options.effort]       — optional reasoning-effort override for capable providers.
 * @param {(runId:string)=>void} [options.onRunCreated] — parent-workflow lifecycle hook.
 * @param {(runId:string)=>void} [options.onRunSettled] — parent-workflow lifecycle hook.
 * @param {boolean} [options.narrativeOnly] — limit output to the story-bible fields a foundation repair persists.
 */
export async function expandWorldTemplate({
  starterPrompt,
  influences,
  preservedVariations = {},
  preservedCompositeSheets = [],
  // Prior bible state — locked entries echo back unchanged, unlocked entries
  // seed the LLM. Renamed to `prior*` so the parsed-LLM-output locals below
  // can keep their canonical names.
  logline: priorLogline = '',
  premise: priorPremise = '',
  styleNotes: priorStyleNotes = '',
  locked = {},
  foundationDirective = '',
  providerId,
  model,
  effort,
  onRunCreated,
  onRunSettled,
  narrativeOnly = false,
} = {}) {
  if (!starterPrompt || !starterPrompt.trim()) {
    throw new Error("starterPrompt is required");
  }
  // Sanitize so a careless caller can't push out-of-cap influence labels into
  // the LLM prompt or the returned result. Empty / missing → empty lists.
  const safeInfluences = sanitizeInfluences(influences);

  // Resolve the model the runner will ACTUALLY execute (honoring CLI baked
  // --model flags) so the log line + returned `llm.model` don't lie.
  const { provider, selectedModel } = await resolveProviderAndModel({ providerId, model });
  assertProvider(provider, { message: "No AI provider available for universe expansion" });

  // Derived from what is ALREADY stored, once, before the retry loop: the write
  // budget must not drift between the prompt that asks for the repair and the
  // contract that validates it.
  const writeTargets = narrativeRepairTargets({
    logline: priorLogline, premise: priorPremise, styleNotes: priorStyleNotes,
  });
  const fullPrompt = buildExpansionPrompt({
    starterPrompt: starterPrompt.trim(),
    influences: safeInfluences,
    preservedVariations,
    preservedCompositeSheets,
    priorLogline,
    priorPremise,
    priorStyleNotes,
    locked,
    foundationDirective,
    narrativeOnly,
    writeTargets,
  });
  const totalIn = safeInfluences.embrace.length + safeInfluences.avoid.length;
  const preservedVarCount = Object.values(preservedVariations || {}).reduce(
    (n, list) => n + (Array.isArray(list) ? list.length : 0),
    0,
  );
  const preservedSheetCount = Array.isArray(preservedCompositeSheets)
    ? preservedCompositeSheets.length
    : 0;
  console.log(
    `🌍 Universe Builder ${narrativeOnly ? 'repairing narrative bible' : 'expanding'} via ${provider.name}/${selectedModel || "default"} — influences in: ${totalIn ? `embrace=${safeInfluences.embrace.length} avoid=${safeInfluences.avoid.length}` : "none"} preserved: variations=${preservedVarCount} sheets=${preservedSheetCount}`,
  );

  // runId is logged so a user debugging an empty expansion can find the raw
  // stdout at data/runs/<runId>/output.txt. Narrative repairs are prose canon:
  // silently slicing one at the persistence boundary can leave a sentence and
  // an operating rule half-written while still reporting success. Validate the
  // model's raw scalar lengths before normalization. An over-limit retry
  // receives the rejected draft itself and a progressively smaller headroom
  // target; asking the original worldbuilding prompt to start over just
  // reproduces the same long answer without converging. A missing-field retry
  // still receives the source task because there is no complete draft to edit.
  let raw;
  let runId;
  let parsed;
  let narrativeViolations = [];
  const maxAttempts = narrativeOnly ? NARRATIVE_REPAIR_MAX_ATTEMPTS : 1;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const prompt = narrativeViolations.length > 0
      ? hasCompleteNarrativeCandidate(parsed)
        ? buildNarrativeCompressionPrompt({
          candidate: parsed,
          violations: narrativeViolations,
          compressionAttempt: attempt,
          writeTargets,
        })
        : `${fullPrompt}\n\n# Storage-contract retry\nThe previous response was incomplete: ${narrativeViolations.join('; ')}. Return a complete replacement with every required field; do not omit or leave any field blank.`
      : fullPrompt;
    const result = await runPromptThroughProvider({
      provider,
      model: selectedModel,
      effort,
      onRunCreated,
      onRunSettled,
      prompt,
      source: narrativeOnly ? "universe-builder-narrative-repair" : "universe-builder-expansion",
    });
    raw = result.text;
    runId = result.runId;
    // Log raw response shape so a "0 variations" outcome is debuggable from
    // the server console alone — the runId points at data/runs/<id>/output.txt
    // for the full transcript.
    console.log(
      `🌍 Universe Builder raw response — runId=${runId} length=${raw?.length || 0}`,
    );
    parsed = extractJson(raw);
    console.log(
      `🌍 Universe Builder parsed JSON — keys=[${Object.keys(parsed || {}).join(",")}] categoryKeys=[${Object.keys(parsed?.categories || {}).join(",")}] compositeSheets=${Array.isArray(parsed?.compositeSheets) ? parsed.compositeSheets.length : 0}`,
    );
    if (!narrativeOnly) break;
    narrativeViolations = narrativeRepairViolations(parsed, writeTargets);
    if (narrativeViolations.length === 0) break;
    if (attempt + 1 < maxAttempts) {
      const retryMode = hasCompleteNarrativeCandidate(parsed)
        ? 'compressing prior draft'
        : 'regenerating incomplete response';
      console.warn(`⚠️ Universe Builder narrative repair exceeded its storage contract — ${retryMode} (attempt ${attempt + 2}/${maxAttempts}): ${narrativeViolations.join('; ')}`);
    }
  }
  if (narrativeViolations.length > 0) {
    // Name the saturated fields in the message: when a repair can't fit, the
    // actionable next step for a human is "consolidate the bible", which is not
    // obvious from a bare character count.
    const saturated = NARRATIVE_FIELD_CAPS
      .map(([key]) => key)
      .filter((key) => writeTargets[key].saturated);
    const saturationNote = saturated.length
      ? ` The stored ${saturated.join(' and ')} already fills its budget, so the repair has no room — consolidate the world bible and retry.`
      : '';
    throw new ServerError(
      `Universe Builder narrative repair failed its storage contract after ${NARRATIVE_REPAIR_MAX_ATTEMPTS} attempts: ${narrativeViolations.join('; ')}.${saturationNote}`,
      { status: 502, code: 'LLM_OUTPUT_CONTRACT' },
    );
  }

  // Distinguish "LLM omitted this key" (return null → client keeps draft)
  // from "LLM returned ''" (return "" → client applies the clear). The
  // client's pick helper in handleExpand treats null/undefined as absent
  // and "" as an intentional value; emitting "" for both cases would
  // clobber existing draft state on every response that misses a field.
  const trimField = (value, max) =>
    typeof value === "string" ? value.trim().slice(0, max) : null;
  const logline = trimField(parsed.logline, LOGLINE_MAX);
  const premise = trimField(parsed.premise, PREMISE_MAX);
  const styleNotes = trimField(parsed.styleNotes, STYLE_NOTES_MAX);
  // Phase A retired the default `characters` category — the persisted
  // sanitizer drops it (RETIRED_CATEGORY_KEYS) and the v3→v4 backfill no
  // longer fires (schemaVersion already ≥4). If the LLM emits a top-level
  // `characters` category bucket here, fold its variations into the canon
  // characters[] return before normalizing, so the entries land in canon
  // instead of being silently dropped on auto-save round-trip.
  const rawCategories = parsed.categories && typeof parsed.categories === 'object' ? parsed.categories : {};
  let rawCharacters = Array.isArray(parsed.characters) ? [...parsed.characters] : [];
  // Match ANY raw key whose first word is "character(s)" — covers exact
  // ("characters"), case variants ("Characters"), and multi-word aliases
  // ("character variations", "Character_Variations") that normalizeCategoryKey
  // encodes as "character_variations" (i.e. NOT equal to "characters").
  // Without this, an LLM emitting a slightly renamed retired-characters key
  // would slip past the exact-equality check and have its entries dropped by
  // sanitizeCategories on save instead of folding into canon.
  const isCharactersBucket = (rawKey) => /^characters?(_|$)/i.test(normalizeCategoryKey(rawKey));
  const survivingCategories = {};
  let foldedAnything = false;
  for (const [rawKey, value] of Object.entries(rawCategories)) {
    if (isCharactersBucket(rawKey)) {
      const variations = Array.isArray(value)
        ? value
        : Array.isArray(value?.variations)
          ? value.variations
          : null;
      if (variations) {
        for (const v of variations) {
          if (typeof v === 'string') {
            const trimmed = v.trim();
            if (trimmed) rawCharacters.push({ name: trimmed });
            continue;
          }
          if (!v || typeof v !== 'object' || !v.label) continue;
          rawCharacters.push({ name: v.label, prompt: v.prompt });
        }
        foldedAnything = true;
        continue; // drop the bucket from the surviving categories
      }
    }
    survivingCategories[rawKey] = value;
  }
  if (foldedAnything) {
    parsed.categories = survivingCategories;
  }
  const categories = normalizeCategories(parsed.categories || {});
  const compositeSheets = normalizeCompositeSheets(
    parsed.compositeSheets || [],
  );
  // normalizeCanonArray stamps `source: BIBLE_SOURCE.UNIVERSE_EXPAND` on each
  // entry before sanitize, so provenance lands on disk consistently with the
  // existing categories→canon backfill in universeBuilder.js.
  const characters = normalizeCanonArray(rawCharacters, BIBLE_KIND.CHARACTER);
  const places = normalizeCanonArray(parsed.places, BIBLE_KIND.PLACE);
  const objects = normalizeCanonArray(parsed.objects, BIBLE_KIND.OBJECT);
  // sanitizeInfluences enforces the same per-entry cap, list cap, and
  // case-insensitive dedupe used everywhere else. Distinguish "LLM omitted
  // influences entirely" (preserve the user's pinned references) from "LLM
  // returned an explicit {embrace:[],avoid:[]}" (apply — user asked to clear
  // them) by checking the raw input shape before sanitization.
  const llmInfluencesRaw = parsed.influences;
  const llmInfluences = sanitizeInfluences(llmInfluencesRaw);
  const influencesOut = (llmInfluencesRaw && typeof llmInfluencesRaw === "object")
    ? {
        embrace: Array.isArray(llmInfluencesRaw.embrace) ? llmInfluences.embrace : safeInfluences.embrace,
        avoid: Array.isArray(llmInfluencesRaw.avoid) ? llmInfluences.avoid : safeInfluences.avoid,
      }
    : safeInfluences;
  const perCat = Object.keys(categories)
    .map((k) => `${k}=${categories[k]?.variations?.length || 0}`)
    .join(" ");
  const totalVariations = Object.values(categories).reduce(
    (n, c) => n + (c?.variations?.length || 0),
    0,
  );
  console.log(
    `🌍 Universe Builder ${narrativeOnly ? 'narrative repair' : 'expansion'} complete — runId=${runId} ${totalVariations} variations, ${compositeSheets.length} composite sheets, canon=${characters.length}/${places.length}/${objects.length} (chars/places/objs), bible=${logline ? "yes" : "no"} (${perCat})`,
  );
  if (!narrativeOnly && totalVariations === 0 && compositeSheets.length === 0 && characters.length === 0 && places.length === 0 && objects.length === 0) {
    console.warn(
      `⚠️ Universe Builder expansion produced 0 variations + 0 canon — inspect data/runs/${runId}/output.txt for the raw LLM response`,
    );
  }

  return {
    logline,
    premise,
    styleNotes,
    influences: influencesOut,
    categories,
    compositeSheets,
    characters,
    places,
    objects,
    llm: { provider: provider.id, model: selectedModel || null },
  };
}

function buildCategoryGeneratePrompt({
  category,
  count,
  existingLabels,
  influences,
  logline,
  premise,
  styleNotes,
}) {
  const embrace = Array.isArray(influences?.embrace) ? influences.embrace.filter(Boolean) : [];
  const avoid = Array.isArray(influences?.avoid) ? influences.avoid.filter(Boolean) : [];
  const influencesSection = embrace.length || avoid.length
    ? `\n# Influences (embrace = style prompt, avoid = negative prompt)\nEmbrace: ${embrace.join(", ") || "(none)"}\nAvoid: ${avoid.join(", ") || "(none)"}\n`
    : "";

  // Influences ship in their own section above; the universe-context helper
  // skips EMBRACE INFLUENCES here so the variations prompt doesn't render
  // them twice with different framing.
  const stateSection = buildUniverseStyleContext(
    { logline, premise, styleNotes },
    {
      includePremise: true,
      includeEmbrace: false,
      headerSuffix: 'keep new variations consistent with this established setting',
    },
  );

  const existingSection = existingLabels.length
    ? `\n# Existing "${category}" variations — DO NOT regenerate these labels or close paraphrases\n${existingLabels.map((l) => `- "${l}"`).join('\n')}\n`
    : "";

  return `You are a universe-building prompt engineer for a Stable-Diffusion-style image generation pipeline. The user has an existing universe and wants ${count} MORE variations added to the "${category}" category.
${stateSection}${influencesSection}${existingSection}
# Output contract
Return a SINGLE JSON object with one key: "variations" — an array of EXACTLY ${count} objects. Each object has the shape:
  { "label": string (max ${LABEL_MAX} chars), "prompt": string (max ${PROMPT_FRAGMENT_MAX} chars, comma-separated tokens describing ONE specific subject in this category) }

# Rules
- Generate ${count} variations — no more, no less.
- Each variation must be visually distinct from the others AND from the existing labels listed above.
- "label" is a short human-recognizable name (e.g. "Crystalline canyon basin", "Scavenger walker mech").
- "prompt" describes the SUBJECT only — the universe's embrace influences are automatically prepended at render time as the style prompt, so do NOT repeat style tokens.
- Do not include camera/aspect tokens; the renderer adds those.
- Stay consistent with the universe context and influences. Lean into the embrace list; avoid the avoid list.
- Output JUST the JSON object. NO markdown, NO commentary.`;
}

const isVariationsShape = (o) =>
  o && typeof o === "object" && Array.isArray(o.variations);

const extractVariationsJson = (raw) => {
  if (!raw || typeof raw !== "string") throw new Error("Empty LLM response");
  const { value, lastError, lastPreview } = extractJsonShared(raw, {
    shapePredicate: isVariationsShape,
  });
  if (value !== undefined) return value;
  throw new ServerError(
    "LLM returned invalid JSON for variation generation. Try a different model or rerun.",
    {
      status: 502,
      code: "LLM_INVALID_JSON",
      context: {
        details: {
          reason: lastError?.message || "no JSON object with variations found",
          preview: lastPreview || "",
        },
      },
    },
  );
};

/**
 * Generate N additional variations for one category. Returns
 * `{ variations: [{label, prompt}], llm: { provider, model } }`. Caller is
 * responsible for merging the result into the universe (dedupe + append).
 */
export async function generateCategoryVariations({
  category,
  count,
  existingLabels = [],
  influences,
  logline = '',
  premise = '',
  styleNotes = '',
  providerId,
  model,
} = {}) {
  const n = Math.max(1, Math.min(VARIATIONS_PER_CATEGORY_MAX, Number(count) || 0));

  const safeInfluences = sanitizeInfluences(influences);
  const safeExisting = Array.isArray(existingLabels)
    ? existingLabels.filter((l) => typeof l === "string" && l.trim()).map((l) => l.trim())
    : [];

  const { provider, selectedModel } = await resolveProviderAndModel({ providerId, model });
  assertProvider(provider, { message: "No AI provider available for variation generation" });

  const fullPrompt = buildCategoryGeneratePrompt({
    category: category.trim(),
    count: n,
    existingLabels: safeExisting,
    influences: safeInfluences,
    logline,
    premise,
    styleNotes,
  });

  console.log(
    `🌍 Universe Builder generating ${n} variations for "${category}" via ${provider.name}/${selectedModel || "default"} — skip-list size=${safeExisting.length}`,
  );

  const { text: raw, runId } = await runPromptThroughProvider({
    provider,
    model: selectedModel,
    prompt: fullPrompt,
    source: "universe-builder-generate-variations",
  });
  console.log(
    `🌍 Universe Builder generate raw response — runId=${runId} length=${raw?.length || 0}`,
  );
  const parsed = extractVariationsJson(raw);

  const normalized = normalizeCategories({ [category]: { variations: parsed.variations } });
  const variations = normalized[category]?.variations || [];

  const seen = new Set(safeExisting.map((l) => l.toLowerCase()));
  const deduped = variations.filter((v) => {
    const key = v.label.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(
    `🌍 Universe Builder generate complete — runId=${runId} requested=${n} returned=${variations.length} kept-after-dedupe=${deduped.length}`,
  );
  if (deduped.length === 0) {
    console.warn(
      `⚠️ Universe Builder generate produced 0 new variations — inspect data/runs/${runId}/output.txt`,
    );
  }

  return {
    variations: deduped,
    llm: { provider: provider.id, model: selectedModel || null },
  };
}

// Export for tests.
export const __testing = {
  extractJson,
  extractVariationsJson,
  normalizeCategories,
  normalizeCompositeSheets,
  normalizeCanonArray,
  buildExpansionPrompt,
  buildCategoryGeneratePrompt,
};
