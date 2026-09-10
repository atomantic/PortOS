import { ServerError } from '../lib/errorHandler.js';
import { extractNonPlaceholderJson } from '../lib/jsonExtract.js';
import { clampToCharLimit, trimTo } from '../lib/textUtils.js';
import { resolveEffectiveModel, runPromptThroughProvider } from './promptRunner.js';
import { getProviderById } from './providers.js';

const MAX_PROMPT_LEN = 8000;
const MAX_REASON_LEN = 1200;
const MAX_CHANGES = 8;

const cleanChanges = (changes) => (
  Array.isArray(changes)
    ? changes.map((c) => trimTo(c, 240)).filter(Boolean).slice(0, MAX_CHANGES)
    : []
);

export function buildMediaPromptRefinePrompt({ kind, prompt, negativePrompt, feedback, renderConfig = {}, maxPromptLength }) {
  const kindLabel = kind === 'video' ? 'video' : 'image';
  // Some render backends cap the prompt and REJECT anything longer instead of
  // truncating it (reactor.inc fast-h3: 800 characters), so an unbounded
  // "make it more vivid" enhancement reliably produces a prompt that cannot
  // be rendered. Give the model the budget it has to write inside;
  // `clampToCharLimit` below is the backstop for when it overshoots anyway.
  const lengthRule = Number.isFinite(maxPromptLength) && maxPromptLength > 0
    ? `\n\nHARD LENGTH LIMIT: the "prompt" field must be AT MOST ${maxPromptLength} characters long (characters, not words) — the renderer REJECTS a longer prompt outright rather than trimming it, so an over-length answer is unusable. Budget the space: keep the highest-value concrete visual detail, drop filler and redundant quality boosters, and stop before the limit rather than writing a longer prompt you expect to be cut. This limit applies to the "prompt" field only.`
    : '';
  if (!feedback || !feedback.trim()) {
    return `You are a senior prompt engineer for generative ${kindLabel} renders.

Take the ORIGINAL POSITIVE PROMPT below and produce an ENHANCED POSITIVE PROMPT that expands it into a vivid, highly detailed, visually rich prompt optimized for AI ${kindLabel} generation. Output the COMPLETE enhanced prompt — not a placeholder, not a summary, not a description of the changes. The "prompt" field MUST contain the full ready-to-render text, paragraph-style, including any preserved details from the original.

Also produce an updated negative prompt and a short rationale.

Return ONLY valid JSON in this schema (replace every <…> with real content; do NOT output the literal angle-bracket text):
{
  "prompt": "<the full enhanced positive prompt, ready to send to the renderer>",
  "negativePrompt": "<the full updated negative prompt, or an empty string if none>",
  "rationale": "<one concise sentence explaining the enhancement>",
  "changes": ["<short bullet of what was enhanced>"]
}

Rules:
- Enhance visual descriptions (lighting, camera angle, atmosphere, textures, details, mood).
- Do not introduce unrelated characters, brands, or conflicting subjects unless requested.
- Keep useful existing style constraints.
- The "prompt" field must NEVER equal the schema placeholder text — it must be the actual enhanced prompt.${lengthRule}

ORIGINAL POSITIVE PROMPT:
${prompt || '(empty)'}

ORIGINAL NEGATIVE PROMPT:
${negativePrompt || '(empty)'}

RENDER CONFIG (kind=${kind}):
${JSON.stringify(renderConfig, null, 2)}`;
  }

  return `You are a senior prompt editor for generative ${kindLabel} renders.

Take the ORIGINAL POSITIVE PROMPT below and produce a NEW POSITIVE PROMPT that fully incorporates the user's feedback. Output the COMPLETE rewritten prompt — not a placeholder, not a summary, not a description of the changes. The "prompt" field MUST contain the full ready-to-render text, paragraph-style, including any preserved details from the original.

Also produce an updated negative prompt and a short rationale.

Return ONLY valid JSON in this schema (replace every <…> with real content; do NOT output the literal angle-bracket text):
{
  "prompt": "<the full rewritten positive prompt, ready to send to the renderer>",
  "negativePrompt": "<the full rewritten negative prompt, or an empty string if none>",
  "rationale": "<one concise sentence explaining the edit>",
  "changes": ["<short bullet of what changed>"]
}

Rules:
- Do not add new story content, characters, objects, camera moves, aspect ratio text, or brand names unless the user asks for them.
- Prefer precise visual-direction edits over vague quality boosters.
- Keep useful existing style constraints unless the user explicitly rejects them.
- Move things the user dislikes into the negative prompt when that improves control.
- If the user asks for a different style, make the positive prompt clearly say what to move toward and the negative prompt clearly say what to avoid.
- The "prompt" field must NEVER equal the schema placeholder text — it must be the actual rewritten render prompt.${lengthRule}

ORIGINAL POSITIVE PROMPT:
${prompt || '(empty)'}

ORIGINAL NEGATIVE PROMPT:
${negativePrompt || '(empty)'}

RENDER CONFIG (kind=${kind}):
${JSON.stringify(renderConfig, null, 2)}

USER FEEDBACK:
${feedback}`;
}

// CLI providers (codex/claude-code/antigravity-cli) need provider-specific arg
// shapes that the toolkit runner already knows about — going through the
// runner avoids the "stdin is not a terminal" failure mode that hits when
// you spawn `codex` directly without the `exec -` invocation.
//
// promptRunner already drops the per-call model for providers that don't
// honor it (see providerHonorsModelOverride), so we pass `model` through
// unconditionally and let the shared layer decide. Wrap runner failures
// in a typed ServerError so the route returns 502 PROMPT_REFINE_FAILED.
function runRefinePrompt(provider, model, prompt, effort) {
  return runPromptThroughProvider({
    provider,
    model,
    effort,
    prompt,
    source: 'media-prompt-refine',
  }).catch((err) => {
    throw new ServerError(err?.message || 'Prompt refinement failed', { status: 502, code: 'PROMPT_REFINE_FAILED' });
  });
}

export async function refineMediaPrompt({
  kind,
  prompt,
  negativePrompt = '',
  feedback = '',
  providerId,
  model,
  effort,
  renderConfig = {},
  maxPromptLength,
}) {
  // Let real failures (providers.json unreadable, toolkit not initialized)
  // bubble through the centralized error handler as 5xx. getProviderById
  // returns null for not-found, which is what 404 PROVIDER_NOT_FOUND is for —
  // don't swallow other rejections into that 404.
  const provider = await getProviderById(providerId);
  if (!provider) {
    throw new ServerError('Provider not found', { status: 404, code: 'PROVIDER_NOT_FOUND' });
  }
  if (provider.enabled === false) {
    throw new ServerError(
      `Provider "${provider.name || provider.id}" is disabled — enable it in Settings → Providers first`,
      { status: 400, code: 'PROVIDER_DISABLED' },
    );
  }

  // Resolve the model that'll actually run via the shared helper so the
  // early MODEL_REQUIRED guard + the response's `model` field match what
  // promptRunner resolves internally. resolveEffectiveModel handles both
  // the API/CLI override gate and the args-baked-CLI case (extracts the
  // args-pinned model id instead of guessing from defaultModel).
  const selectedModel = resolveEffectiveModel(provider, model) || '';
  if (!selectedModel && provider.type === 'api') {
    throw new ServerError('Model is required for prompt refinement', { status: 400, code: 'MODEL_REQUIRED' });
  }

  const llmPrompt = buildMediaPromptRefinePrompt({
    kind,
    prompt: trimTo(prompt, MAX_PROMPT_LEN),
    negativePrompt: trimTo(negativePrompt, MAX_PROMPT_LEN),
    feedback: trimTo(feedback, 3000),
    renderConfig,
    maxPromptLength,
  });

  const { text, runId } = await runRefinePrompt(provider, selectedModel, llmPrompt, effort);

  let parsed;
  try {
    parsed = extractNonPlaceholderJson(text || '', { field: 'prompt' });
  } catch (e) {
    // Log only the response size + error reason, not the raw body. The body
    // can contain user prompts or other sensitive content; the persisted
    // run artifact at `data/runs/<runId>/output.txt` already captures the
    // full response for offline debugging.
    // Log the runId so operators can locate the full response — the actual
    // path depends on the runner's configured data dir, so let the Runs UI /
    // tooling resolve the artifact rather than printing a path that may be
    // wrong when dataDir isn't the default.
    console.warn(`⚠️ media-prompt-refine [${provider.id}/${selectedModel || 'default'} runId=${runId}] parse failed: ${e.message} (response size: ${(text || '').length} chars)`);
    throw new ServerError(e.message, { status: 502, code: 'PROMPT_REFINE_BAD_JSON' });
  }

  const refinedPrompt = trimTo(parsed.prompt, MAX_PROMPT_LEN);
  if (!refinedPrompt) {
    throw new ServerError('LLM returned an empty prompt', { status: 502, code: 'PROMPT_REFINE_EMPTY_PROMPT' });
  }

  // The model is TOLD the cap (see `lengthRule`), but a model that overshoots
  // by a few characters would hand the user a prompt the renderer rejects
  // outright — reactor.inc's fast-h3 refuses an over-length prompt rather than
  // trimming it. Report the clamp rather than swallowing it, so a shortened
  // prompt doesn't read as the model losing detail on its own.
  const { text: boundedPrompt, truncated } = clampToCharLimit(refinedPrompt, maxPromptLength);
  if (truncated) {
    console.warn(`✂️ media-prompt-refine [${provider.id}/${selectedModel || 'default'}] trimmed enhanced prompt ${refinedPrompt.length}→${boundedPrompt.length} chars (limit ${maxPromptLength})`);
  }

  return {
    prompt: boundedPrompt,
    negativePrompt: trimTo(parsed.negativePrompt, MAX_PROMPT_LEN),
    rationale: trimTo(parsed.rationale, MAX_REASON_LEN),
    changes: cleanChanges(parsed.changes),
    providerId: provider.id,
    model: selectedModel,
    truncated,
  };
}
