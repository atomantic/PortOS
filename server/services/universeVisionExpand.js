/**
 * Universe Character — vision-driven structured expansion.
 *
 * The text-based sibling `universeCharacterExpand.js` fleshes out a character's
 * blank fields from its EXISTING data. This one does the same job from one or
 * more REFERENCE IMAGES: a vision-capable model looks at the image(s) and
 * returns a JSON object of the character's structured attributes (palette,
 * physical/visual notes, expressions, …), which we merge no-clobber onto the
 * canon entry.
 *
 * Review-then-apply, WITHOUT a second LLM round-trip: this service only
 * PROPOSES. It runs the vision model once, computes the no-clobber merge
 * against the character's still-blank fields, and returns the proposed field
 * values for review. The client shows them (editable) and, on Apply, writes the
 * kept values through the normal entry-PATCH path — so user edits are honored,
 * the write is serialized by the existing universe write queue, and we never
 * pay for a second non-deterministic LLM call.
 *
 * Vision is an API-provider-only capability (only the toolkit's executeApiRun
 * base64-inlines images). We resolve an API provider up front and reject a
 * fallback to a non-vision provider so the model is guaranteed to actually see
 * the references rather than hallucinating attributes from the text prompt.
 *
 * Merge semantics mirror the text expand exactly (`applyExpansion`):
 *   - key absent → preserve existing
 *   - key present but empty → no-op
 *   - key present, non-empty → fill ONLY when the target field is blank
 */

import { getUniverse } from './universeBuilder.js';
import {
  applyExpansion,
  STRING_FIELDS,
  LIST_FIELDS,
  isBlankString,
  isBlankArray,
} from './universeCharacterExpand.js';
import { resolveAPIProvider, parseLLMJSON } from '../lib/aiProvider.js';
import { runPromptThroughProvider, assertProvider, assertVisionRunUsedImages } from '../lib/promptRunner.js';
import { ServerError } from '../lib/errorHandler.js';
import { shortId } from '../lib/fileUtils.js';

// Cap mirrors VISION_MAX_IMAGES in universeVisionDescribe.js — the runner
// base64-inlines every image into a single request body, so a large batch
// balloons the prompt and the provider's context window.
export const VISION_EXPAND_MAX_IMAGES = 8;

// Per-list-field row-shape guidance so the model returns rows that survive
// `sanitizeCharacter` (which drops rows missing the required key). Keep in sync
// with the sanitizer's row shapes in storyBible.js.
const LIST_FIELD_SHAPES = {
  stats: '{ "label": "<attribute name>", "value": "<value>" }',
  colorPalette: '{ "name": "<swatch name>", "hex": "#rrggbb", "role": "<where it appears>" }',
  props: '{ "name": "<prop name>", "purpose": "<why they carry it>", "materials": "<materials>", "notes": "<notes>" }',
  expressions: '{ "name": "<expression>", "description": "<how it reads on their face>" }',
  handGestures: '{ "name": "<gesture>", "description": "<the hand pose>" }',
};

// Non-visual character-framework fields (CWQE Phase 10, #2175). They live in the
// shared STRING_FIELDS / LIST_FIELDS lists (the text/vision expand flows share
// one source of truth) but a vision model CANNOT infer a character's Ghost, Lie,
// Want, Need, or secrets from an image — those are narrative, not renderable. So
// the vision prompt excludes them (they'd only invite hallucinated backstory,
// and `secrets` has no LIST_FIELD_SHAPES row shape to emit). arcType / sliders
// are already absent from both shared lists (merged specially in the text flow),
// so they never reach the vision prompt either.
const NON_VISUAL_FRAMEWORK_FIELDS = new Set(['ghost', 'wound', 'lie', 'want', 'need', 'secrets']);

/**
 * Build the vision prompt. The model is told to return ONE JSON object keyed by
 * the structured character fields, populating only those it can infer from the
 * image(s) and focusing on the still-blank ones. No prose, no markdown.
 */
export function buildVisionExpandPrompt({ name, context, imageCount = 1, blankFields = [] }) {
  const subject = name ? `the character "${name}"` : 'this character';
  const intro = imageCount > 1
    ? `You are looking at ${imageCount} reference images of the same character${name ? ` (${subject})` : ''}. They show the same subject under different conditions (angle, lighting, framing, background). Read the visual traits that stay CONSISTENT across all of them and describe that single shared subject — ignore differences incidental to any one shot.`
    : `You are looking at a reference image of ${subject}.`;

  const ctx = context && context.trim()
    ? `\n\nKnown context (use it to disambiguate, do not contradict the images): ${context.trim()}`
    : '';

  // Narrow the ask to the fields that are still blank when we have that list;
  // otherwise offer the full set. Populated fields are no-clobber server-side
  // regardless, so this is purely to focus the model.
  // Non-visual framework fields (ghost/lie/…/secrets) are never asked of a
  // vision model — filter them out of both the full-set and blank-narrowed asks.
  const visualStringFields = STRING_FIELDS.filter((f) => !NON_VISUAL_FRAMEWORK_FIELDS.has(f));
  const visualListFields = LIST_FIELDS.filter((f) => !NON_VISUAL_FRAMEWORK_FIELDS.has(f));
  const stringTargets = blankFields.length
    ? visualStringFields.filter((f) => blankFields.includes(f))
    : visualStringFields;
  const listTargets = blankFields.length
    ? visualListFields.filter((f) => blankFields.includes(f))
    : visualListFields;

  const stringLines = stringTargets.map((f) => `  "${f}": "<string>"`).join(',\n');
  const listLines = listTargets
    .map((f) => `  "${f}": [ ${LIST_FIELD_SHAPES[f]} ]`)
    .join(',\n');
  const schemaBody = [stringLines, listLines].filter(Boolean).join(',\n');

  return `${intro}

You are a graphic-novelist's character-reference analyst. Extract the character's renderable visual + design attributes from the image(s) so they can seed a story bible.

Return ONLY a single valid JSON object in this shape (replace every <…> with real content; do NOT output the literal angle-bracket text). OMIT any key you cannot confidently infer from the image(s) — an omitted key means "no opinion" and is preferred over a guess:
{
${schemaBody}
}

Rules:
- Base every value on what is VISIBLE in the image(s). Do not invent backstory, plot, or facts the image cannot show.
- String fields: concise, concrete, renderable phrasing (comma-separated descriptive phrases work well). No markdown, no headings, no commentary about the images themselves.
- List fields: return an array of objects in the exact shape shown. Omit the whole field rather than emitting rows you cannot fill.
- Output only the JSON object — no preamble, no code fences, no trailing prose.${ctx}`;
}

/**
 * Expand a universe character's structured attributes from reference image(s).
 *
 * @param {object} args
 * @param {string} args.universeId
 * @param {string} args.entryId — character id
 * @param {string} [args.name] — entity name, for prompt context
 * @param {string} [args.context] — extra known context to disambiguate
 * @param {string[]} args.screenshots — image paths the runner can load (bare
 *   filenames under data/screenshots, or absolute paths for gallery images)
 * @param {string} [args.providerId] — preferred API provider id
 * @param {string} [args.model] — preferred model id
 * @returns {Promise<object>} `{ fields, updatedFields, llm }` where `fields` is
 *   a `{ name: value }` map of the blank attributes the model proposes filling
 *   (already merged + sanitized), or `{ locked: true, updatedFields: [] }` when
 *   the character is locked.
 */
export async function expandEntityFromImages({
  universeId, entryId, name, context, screenshots, providerId, model,
} = {}) {
  const images = Array.isArray(screenshots) ? screenshots.filter((s) => typeof s === 'string' && s.trim()) : [];
  if (images.length === 0) {
    throw new ServerError('At least one image is required', { status: 400, code: 'VALIDATION_ERROR' });
  }
  if (images.length > VISION_EXPAND_MAX_IMAGES) {
    throw new ServerError(`Too many images — analyze at most ${VISION_EXPAND_MAX_IMAGES} at once`, {
      status: 400, code: 'VALIDATION_ERROR',
    });
  }

  const universe = await getUniverse(universeId);
  const list = Array.isArray(universe.characters) ? universe.characters : [];
  const idx = list.findIndex((e) => e.id === entryId);
  if (idx < 0) {
    throw new ServerError(`Character ${entryId} not found in universe`, {
      status: 404, code: 'UNIVERSE_CANON_NOT_FOUND',
    });
  }
  const target = list[idx];
  if (target.locked === true) {
    return { universe, entry: target, locked: true, updatedFields: [] };
  }

  const blankFields = [
    ...STRING_FIELDS.filter((f) => isBlankString(target[f])),
    ...LIST_FIELDS.filter((f) => isBlankArray(target[f])),
  ];

  const provider = await resolveAPIProvider(providerId);
  assertProvider(provider, {
    message:
      'Analyzing an image needs an API-based AI provider with a vision-capable model (e.g. Ollama with a llava/qwen-vl model, LM Studio, or an OpenAI-compatible endpoint). Configure one under Settings → Providers.',
    code: 'NO_API_PROVIDER',
    status: 503,
  });

  const prompt = buildVisionExpandPrompt({
    name, context, imageCount: images.length, blankFields,
  });

  const result = await runPromptThroughProvider({
    provider,
    prompt,
    source: 'universe-vision-expand',
    model: model || undefined,
    screenshots: images,
  });

  // A CLI/TUI fallback silently drops the images and would return attributes
  // hallucinated from the text prompt alone — reject it outright.
  const ranProvider = assertVisionRunUsedImages(result, provider);

  let content;
  try {
    content = parseLLMJSON(result.text || '');
  } catch (e) {
    throw new ServerError(e.message, { status: 502, code: 'UNIVERSE_VISION_EXPAND_BAD_JSON' });
  }
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    throw new ServerError('The vision model returned a non-object response — try a different model or clearer images.', {
      status: 502, code: 'UNIVERSE_VISION_EXPAND_BAD_JSON',
    });
  }

  const llm = { provider: ranProvider.id || provider.id, model: result.model || null };

  // Compute the no-clobber merge against the loaded target — `applyExpansion`
  // fills only blank fields and sanitizes list rows. Surface just the fields it
  // would fill (name → merged value) so the modal can present them for review;
  // the client applies the kept/edited values via the normal entry-PATCH path.
  const { merged, updatedFields } = applyExpansion(target, content);
  const fields = {};
  for (const f of updatedFields) fields[f] = merged[f];
  if (updatedFields.length > 0) {
    console.log(`✨ Universe vision expand proposed — universe=${shortId(universeId)} entry=${shortId(entryId)} fields=${updatedFields.length}`);
  }
  return { fields, updatedFields, llm };
}

export const __testing = { buildVisionExpandPrompt };
