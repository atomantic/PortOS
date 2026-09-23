/**
 * Mood board → universe style synthesis (#4188 Phase 4).
 *
 * Stateless, mirroring `analyzeUniverseStyleReference`: one text LLM run over
 * the board's collected content (description, text notes, captions, and the
 * per-item prompt-from-media analyses Phase 3 persists), proposing
 * `{ styleNotes, influences: { embrace, avoid } }` shaped for the universe
 * style guide, plus the same diff the style-reference review step renders.
 * Nothing is persisted here — the client previews the diff and adoption goes
 * through the universe's queued-write adopt endpoint.
 */

import { parseLLMJSON, resolveAPIProvider } from './aiProvider.js';
import { ServerError } from '../lib/errorHandler.js';
import { assertProvider, runPromptThroughProvider } from './promptRunner.js';
import {
  sanitizeInfluences,
  sanitizeLocked,
  STYLE_NOTES_MAX,
} from './universeBuilder.js';
import { buildStyleReferenceDiff } from './universeStyleReference.js';
import { trimTo } from '../lib/textUtils.js';
import { collectBoardStyleContext } from './moodBoard/styleContext.js';

const RATIONALE_MAX = 1000;

export function buildBoardStyleSynthesisPrompt({ context, styleNotes, influences, locked }) {
  const payload = JSON.stringify({
    board: context,
    currentStyleNotes: trimTo(styleNotes, STYLE_NOTES_MAX),
    currentGuidance: sanitizeInfluences(influences),
    locked: sanitizeLocked(locked),
  });
  return `Synthesize a UNIVERSE VISUAL STYLE GUIDE from the mood board below. The board collects a user's curated inspiration: text notes, image/video captions, and per-item AI analyses (render prompts reverse-engineered from the pinned media).

Distill the board into renderable visual style guidance: medium, line or brush treatment, shapes, texture, palette, lighting, composition, era, mood, and finish. Find the through-line across the items — what this board consistently embraces and what it consistently avoids — rather than describing any single item. Do not invent story facts, named characters, locations, or copyrighted-artist attribution.

Mood board and current universe context:
${payload}

Return JSON only:
{
  "styleNotes": "complete proposed replacement for currentStyleNotes, prose",
  "influences": {
    "embrace": ["complete ordered positive style-token list"],
    "avoid": ["complete ordered negative style-token list"]
  },
  "rationale": "one concise explanation of the synthesized direction"
}

Honor every locked field: styleNotes, influencesEmbrace, or influencesAvoid must remain equivalent to the corresponding current value when locked. Preserve useful current guidance that does not conflict with the board. An empty array is a valid intentional recommendation.`;
}

export async function synthesizeBoardStyle({
  board,
  styleNotes,
  influences,
  locked,
  providerId,
  model,
} = {}) {
  const context = collectBoardStyleContext(board);
  if (!context.description && !context.items.length) {
    throw new ServerError(
      'This board has nothing to synthesize from yet — analyze some items, add captions or notes, or give the board a description first.',
      { status: 400, code: 'NOTHING_TO_SYNTHESIZE' },
    );
  }

  const provider = await resolveAPIProvider(providerId);
  assertProvider(provider, {
    message: 'Synthesizing a style guide needs an API-based provider. Configure one under Settings → Providers.',
    code: 'NO_API_PROVIDER',
    status: 503,
  });

  const result = await runPromptThroughProvider({
    provider,
    prompt: buildBoardStyleSynthesisPrompt({ context, styleNotes, influences, locked }),
    source: 'mood-board-style-synthesis',
    model: model || undefined,
  });
  let parsed;
  try {
    parsed = parseLLMJSON(result.text || '');
  } catch (error) {
    throw new ServerError(`The model returned invalid style synthesis: ${error.message}`, {
      status: 502,
      code: 'SYNTHESIS_BAD_JSON',
    });
  }

  const currentInfluences = sanitizeInfluences(influences);
  const safeLocked = sanitizeLocked(locked);
  const parsedInfluences = parsed?.influences && typeof parsed.influences === 'object'
    ? parsed.influences
    : {};
  // Locked fields keep their current value verbatim regardless of what the
  // model proposed — the same belt the style-reference analyzer wears; the
  // adopt write re-checks locks against the freshest persisted record.
  const proposed = {
    styleNotes: safeLocked.styleNotes
      ? trimTo(styleNotes, STYLE_NOTES_MAX)
      : (typeof parsed?.styleNotes === 'string'
        ? trimTo(parsed.styleNotes, STYLE_NOTES_MAX)
        : trimTo(styleNotes, STYLE_NOTES_MAX)),
    influences: {
      embrace: safeLocked.influencesEmbrace
        ? currentInfluences.embrace
        : (Array.isArray(parsedInfluences.embrace)
          ? sanitizeInfluences({ embrace: parsedInfluences.embrace }).embrace
          : currentInfluences.embrace),
      avoid: safeLocked.influencesAvoid
        ? currentInfluences.avoid
        : (Array.isArray(parsedInfluences.avoid)
          ? sanitizeInfluences({ avoid: parsedInfluences.avoid }).avoid
          : currentInfluences.avoid),
    },
  };

  return {
    proposed,
    diff: buildStyleReferenceDiff({ styleNotes, influences: currentInfluences }, proposed),
    rationale: trimTo(parsed?.rationale, RATIONALE_MAX),
    context: { items: context.items.length, droppedItems: context.droppedItems },
    llm: {
      provider: result.provider?.id || provider.id,
      model: result.model || null,
    },
  };
}

export const __testing = { buildBoardStyleSynthesisPrompt };
