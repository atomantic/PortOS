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

import { parseLLMJSON, resolveAPIProvider } from '../lib/aiProvider.js';
import { ServerError } from '../lib/errorHandler.js';
import { assertProvider, runPromptThroughProvider } from '../lib/promptRunner.js';
import { trimTo } from '../lib/storyBible.js';
import {
  sanitizeInfluences,
  sanitizeLocked,
  STYLE_NOTES_MAX,
} from './universeBuilder.js';
import { buildStyleReferenceDiff } from './universeStyleReference.js';

// Context bounds: a board caps at 500 items, but the synthesis context must
// stay well inside a chat-completion window. Items are taken in board order
// (the user's curation order); fragments beyond either cap are dropped and
// the count is reported in the result so the UI can say so. The aggregate
// character budget is the load-bearing one — 60 items can each carry four
// 600-char fields, far past what a small local model's window fits — and it
// is a FIXED conservative budget (≈6k tokens) rather than model-aware:
// provider window metadata isn't reliably known here, and a proposal
// synthesized from the first N curated items beats a request the model
// truncates or rejects.
const CONTEXT_ITEMS_MAX = 60;
const CONTEXT_FIELD_MAX = 600;
const CONTEXT_TOTAL_CHARS_MAX = 24000;
const RATIONALE_MAX = 1000;

/**
 * Reduce a board to the style-relevant text fragments the LLM sees. An item
 * contributes only what it actually carries: a text note, a caption, and/or a
 * persisted analysis (prompt + negative + rationale). Media items without any
 * of those contribute nothing — synthesis reads text, not pixels (analyzing
 * an item is Phase 3's explicit per-item vision step).
 */
export function collectBoardStyleContext(board) {
  const items = Array.isArray(board?.items) ? board.items : [];
  const fragments = [];
  let dropped = 0;
  let totalChars = 0;
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const entry = {};
    if (it.type === 'text' && typeof it.text === 'string' && it.text.trim()) {
      entry.note = trimTo(it.text, CONTEXT_FIELD_MAX);
    }
    if (typeof it.caption === 'string' && it.caption.trim()) {
      entry.caption = trimTo(it.caption, CONTEXT_FIELD_MAX);
    }
    const analysis = it.analysis;
    if (analysis && typeof analysis === 'object' && typeof analysis.prompt === 'string' && analysis.prompt.trim()) {
      entry.analyzedPrompt = trimTo(analysis.prompt, CONTEXT_FIELD_MAX);
      if (typeof analysis.negativePrompt === 'string' && analysis.negativePrompt.trim()) {
        entry.analyzedNegative = trimTo(analysis.negativePrompt, CONTEXT_FIELD_MAX);
      }
      if (typeof analysis.rationale === 'string' && analysis.rationale.trim()) {
        entry.analysisRationale = trimTo(analysis.rationale, CONTEXT_FIELD_MAX);
      }
    }
    if (!Object.keys(entry).length) continue;
    const entrySize = Object.values(entry).reduce((sum, v) => sum + v.length, 0);
    if (fragments.length >= CONTEXT_ITEMS_MAX || totalChars + entrySize > CONTEXT_TOTAL_CHARS_MAX) {
      dropped += 1;
      continue;
    }
    totalChars += entrySize;
    fragments.push({ kind: it.type, ...entry });
  }
  return {
    name: trimTo(board?.name, 200) || null,
    description: trimTo(board?.description, 2000) || null,
    items: fragments,
    droppedItems: dropped,
  };
}

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

export const __testing = { collectBoardStyleContext, buildBoardStyleSynthesisPrompt };
