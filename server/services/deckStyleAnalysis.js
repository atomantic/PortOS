/**
 * Deck sample analysis — turn one sample design (a poster, another card, a
 * painting) into a style guide proposal for a card deck.
 *
 * Stateless, like the universe art-style reference step
 * (`universeStyleReference.js`): the vision model sees the gallery image plus
 * the deck's CURRENT style guide and proposes a complete replacement
 * (`styleNotes`, `influences`, a kind-specific `layoutPrompt`) along with a
 * recreation prompt for the sample itself. The client reviews the diff and
 * persists through `addSample` — nothing is written here.
 *
 * Vision is an API-provider capability (the runner only base64-inlines images
 * on that path), so an API provider is resolved up front and a silent CLI/TUI
 * fallback that dropped the image is rejected rather than reported as
 * image-grounded output.
 */

import { randomUUID } from 'node:crypto';
import { ServerError } from '../lib/errorHandler.js';
import { trimTo } from '../lib/textUtils.js';
import { DECK_KIND_LABELS, DEFAULT_LAYOUT_PROMPT } from '../lib/deckTemplates.js';
import { DECK_LAYOUT_PROMPT_MAX, DECK_SAMPLE_PROMPT_MAX, DECK_SAMPLE_TITLE_MAX } from '../lib/deckValidation.js';
import { STYLE_NOTES_MAX } from '../lib/universeBibleLimits.js';
import { universeVisualStyleTokens } from '../lib/universeVisualStyle.js';

export function buildDeckSamplePrompt({ deck, title }) {
  const kindLabel = DECK_KIND_LABELS[deck.kind] || deck.kind;
  const context = JSON.stringify({
    deckName: deck.name,
    deckKind: kindLabel,
    suppliedTitle: trimTo(title, DECK_SAMPLE_TITLE_MAX) || null,
    currentStyleNotes: trimTo(deck.styleNotes, STYLE_NOTES_MAX),
    currentInfluences: universeVisualStyleTokens(deck),
    currentLayoutPrompt: trimTo(deck.layoutPrompt, DECK_LAYOUT_PROMPT_MAX) || DEFAULT_LAYOUT_PROMPT[deck.kind],
  });
  return `Analyze the attached image as a SAMPLE DESIGN for a ${kindLabel} deck called "${deck.name}". Every card in the deck must read as one physical object printed in this visual language.

Concentrate on renderable visual style: medium and finish (engraving, gouache, risograph, foil, letterpress…), line and brush treatment, palette (name the dominant colors and the paper/ground tone), lighting, texture, ornament and border language, typographic feel, era and mood. Also decide how a single CARD in this style should be laid out — border/frame treatment, where indices or titles sit, how much of the face the central illustration fills. Do not invent story facts or named characters, and do not attribute the style to a copyrighted living artist.

Current deck context:
${context}

Return JSON only:
{
  "title": "short descriptive sample title (generate only when suppliedTitle is null)",
  "prompt": "detailed image-generation prompt that would recreate this sample image",
  "styleNotes": "complete replacement for currentStyleNotes: 2–4 sentences of art direction for the whole deck",
  "influences": {
    "embrace": ["complete ordered list of 8–18 comma-free style tokens an image model should lean into"],
    "avoid": ["complete ordered list of 4–12 tokens for the negative prompt"]
  },
  "layoutPrompt": "one sentence describing the shared card layout in this style (border, index/title placement, illustration framing) — keep it usable as a prefix on every card prompt",
  "rationale": "one concise explanation of the proposed changes"
}

Preserve useful current guidance that does not conflict with the sample. An empty array is a valid intentional recommendation.`;
}

/**
 * @returns {Promise<{ sample, proposed, diff, rationale, llm }>}
 */
export async function analyzeDeckSample({ deck, imagePath, imageFilename, title, providerId, model, effort } = {}) {
  if (!deck?.id || !imagePath || !imageFilename) {
    throw new ServerError('A deck and a gallery image are required', { status: 400, code: 'VALIDATION_ERROR' });
  }
  // Provider resolution + the runner load on the first analysis, not at import.
  const [{ parseLLMJSON, resolveAPIProvider }, { assertProvider, assertVisionRunUsedImages, runPromptThroughProvider }] = await Promise.all([
    import('./aiProvider.js'), import('./promptRunner.js'),
  ]);
  const provider = await resolveAPIProvider(providerId);
  assertProvider(provider, {
    message: 'Analyzing a sample design needs an API-based provider with a vision-capable model. Configure one under Settings → Providers.',
    code: 'NO_API_PROVIDER',
    status: 503,
  });
  const result = await runPromptThroughProvider({
    provider,
    prompt: buildDeckSamplePrompt({ deck, title }),
    source: 'deck-sample-analysis',
    model: model || undefined,
    effort: effort || undefined,
    screenshots: [imagePath],
  });
  const ranProvider = assertVisionRunUsedImages(result, provider);
  let parsed;
  try {
    parsed = parseLLMJSON(result.text || '');
  } catch (error) {
    throw new ServerError(`The vision model returned invalid style analysis: ${error.message}`, {
      status: 502,
      code: 'VISION_BAD_JSON',
    });
  }

  const samplePrompt = trimTo(parsed?.prompt, DECK_SAMPLE_PROMPT_MAX);
  if (!samplePrompt) {
    throw new ServerError('The vision model returned no recreation prompt — try a different model or a clearer image.', {
      status: 502,
      code: 'VISION_EMPTY',
    });
  }
  // Lazy: the universe style-reference module drags the universe barrel, which
  // only this call path needs.
  const { buildStyleReferenceDiff } = await import('./universeStyleReference.js');
  const current = {
    styleNotes: trimTo(deck.styleNotes, STYLE_NOTES_MAX),
    influences: universeVisualStyleTokens(deck),
    layoutPrompt: trimTo(deck.layoutPrompt, DECK_LAYOUT_PROMPT_MAX),
  };
  // Absent vs present: a list the model omitted keeps the current one; a list
  // it returned (even empty) is its intentional recommendation.
  const parsedInfluences = parsed?.influences && typeof parsed.influences === 'object' ? parsed.influences : {};
  const proposedTokens = universeVisualStyleTokens({ influences: parsedInfluences });
  const proposed = {
    styleNotes: typeof parsed?.styleNotes === 'string' ? trimTo(parsed.styleNotes, STYLE_NOTES_MAX) : current.styleNotes,
    influences: {
      embrace: Array.isArray(parsedInfluences.embrace) ? proposedTokens.embrace : current.influences.embrace,
      avoid: Array.isArray(parsedInfluences.avoid) ? proposedTokens.avoid : current.influences.avoid,
    },
    layoutPrompt: trimTo(parsed?.layoutPrompt, DECK_LAYOUT_PROMPT_MAX) || current.layoutPrompt,
  };

  return {
    sample: {
      id: `deck-sample-${randomUUID()}`,
      title: trimTo(title, DECK_SAMPLE_TITLE_MAX) || trimTo(parsed?.title, DECK_SAMPLE_TITLE_MAX) || 'Sample design',
      prompt: samplePrompt,
      imageRef: imageFilename,
      createdAt: new Date().toISOString(),
    },
    proposed,
    diff: {
      ...buildStyleReferenceDiff(current, proposed),
      layoutPrompt: {
        before: current.layoutPrompt,
        after: proposed.layoutPrompt,
        changed: current.layoutPrompt !== proposed.layoutPrompt,
      },
    },
    rationale: trimTo(parsed?.rationale, 1000),
    llm: { provider: ranProvider.id || provider.id, model: result.model || null },
  };
}

export const __testing = { buildDeckSamplePrompt };
