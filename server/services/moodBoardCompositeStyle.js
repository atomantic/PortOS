/**
 * Mood board composite style prompt.
 *
 * Per-item prompt-from-media already decomposes each pin into a render prompt.
 * This run does not look at pixels again: it distills those stored prompts
 * (plus captions and notes) into ONE still-image prompt — the board's
 * canonical look — and the board page renders that prompt on whatever image
 * service the user picks. Nothing here calls a vision model.
 */

import { parseLLMJSON, resolveAPIProvider } from './aiProvider.js';
import { ServerError } from '../lib/errorHandler.js';
import { assertProvider, runPromptThroughProvider } from './promptRunner.js';
import { trimTo } from '../lib/textUtils.js';
import { collectBoardStyleContext } from './moodBoard/styleContext.js';

const PROMPT_MAX = 8000;
const REASON_MAX = 1200;

function analyzedItems(board) {
  const items = Array.isArray(board?.items) ? board.items : [];
  return items.filter((it) => (it?.analysis && typeof it.analysis.prompt === 'string' && it.analysis.prompt.trim())
    || (typeof it?.caption === 'string' && it.caption.trim()));
}

// Analyses/captions first so the context budget spends itself on decomposed prompts
// and item captions before notes. The stored board order is not rewritten.
function withAnalysesFirst(board) {
  const items = Array.isArray(board?.items) ? board.items : [];
  const analyzed = [];
  const rest = [];
  for (const it of items) {
    const hasPrompt = (it?.analysis && typeof it.analysis.prompt === 'string' && it.analysis.prompt.trim())
      || (typeof it?.caption === 'string' && it.caption.trim());
    if (hasPrompt) analyzed.push(it);
    else rest.push(it);
  }
  return { ...board, items: [...analyzed, ...rest] };
}

const contentPrompt = (text) => trimTo(text, PROMPT_MAX)
  .replace(/^(?:please\s+)?(?:create|generate|render|make)\s+(?:(?:an?|the)\s+(?:image|picture|poster)\s+(?:of|showing|depicting)\s+)?/i, '')
  .trim();

function buildCompositeStylePrompt({ context, analyzedItemCount }) {
  const payload = JSON.stringify({ board: context, analyzedItemCount });
  return `You are a senior prompt engineer. Compose ONE ready-to-render still-image prompt that captures the shared visual style of a mood board.

The board's items have already been decomposed: each "analyzedPrompt" or "caption" is a render prompt reverse-engineered or carried by that pin. Treat those prompts and captions as the source of truth. Captions and notes are supporting context only. Find the through-line — medium, mark-making, palette, light, texture, lens, composition, mood — and write a single prompt for a canonical reference image of that style. The image is a poster for the board itself: an editorial style reference a viewer would recognize as this board's look, not a collage that restates every item's subject, and not a description of one pin.

Do not invent named characters, brands, logos, or copyrighted-artist attribution that the analyses do not already state.

Mood board:
${payload}

Return JSON only:
{
  "prompt": "<complete ready-to-render still-image prompt>",
  "negativePrompt": "<what the image model should avoid, or empty string>",
  "rationale": "<one concise sentence naming the through-line>"
}

Rules:
- Output ONLY valid JSON.
- prompt is the COMPLETE render text, paragraph-style. Start with the subject or scene. Never prefix it with Create, Generate, Make, or Render an image of.
- No motion language. This prompt is for a still poster.
- An empty negativePrompt is valid when the analyses share no consistent avoid.`;
}

export async function composeBoardPrompt({ board, providerId, model } = {}) {
  const analyzed = analyzedItems(board);
  if (!analyzed.length) {
    throw new ServerError(
      'Analyze at least one item with prompt-from-media or add captions before composing a board style. The composite is built from those prompts.',
      { status: 400, code: 'NOTHING_ANALYZED' },
    );
  }

  const context = collectBoardStyleContext(withAnalysesFirst(board));
  const fed = context.items.filter((it) => it.analyzedPrompt || it.caption).length;
  if (!fed) {
    throw new ServerError(
      'The item analyses or captions did not fit the style context. Remove some notes and compose again.',
      { status: 400, code: 'NOTHING_ANALYZED' },
    );
  }

  const provider = await resolveAPIProvider(providerId);
  assertProvider(provider, {
    message: 'Composing a board style needs an API-based provider. Configure one under Settings → Providers.',
    code: 'NO_API_PROVIDER',
    status: 503,
  });

  const result = await runPromptThroughProvider({
    provider,
    prompt: buildCompositeStylePrompt({ context, analyzedItemCount: fed }),
    source: 'mood-board-composite-style',
    model: model || undefined,
  });
  let parsed;
  try {
    parsed = parseLLMJSON(result.text || '');
  } catch (error) {
    throw new ServerError(`The model returned invalid board style: ${error.message}`, {
      status: 502,
      code: 'COMPOSITE_BAD_JSON',
    });
  }

  const prompt = contentPrompt(parsed?.prompt);
  if (!prompt) {
    throw new ServerError('The model returned an empty board style prompt', {
      status: 502,
      code: 'COMPOSITE_BAD_JSON',
    });
  }
  const negative = trimTo(parsed?.negativePrompt, PROMPT_MAX);

  return {
    prompt,
    negativePrompt: negative || null,
    rationale: trimTo(parsed?.rationale, REASON_MAX) || null,
    analyzedItemCount: fed,
    providerId: result.provider?.id || provider.id || null,
    model: result.model || null,
    composedAt: new Date().toISOString(),
  };
}

