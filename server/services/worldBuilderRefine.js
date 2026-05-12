/**
 * World Builder — refine the 3 top-level prompts (starter idea, style prompt,
 * negative prompt) based on user feedback. Mirrors the media prompt-refine
 * flow (see `mediaPromptRefiner.js`) but operates on a world template rather
 * than an individual render.
 *
 * The LLM gets the originals + a free-form feedback string and returns:
 *   { starterPrompt, stylePrompt, negativePrompt, rationale, changes? }
 *
 * The caller (route → UI) presents the refined fields for review before they
 * overwrite the draft, so the LLM never silently mutates a saved world.
 */

import { ServerError } from '../lib/errorHandler.js';
import { getActiveProvider, getProviderById } from './providers.js';
import { createRun, executeApiRun, executeCliRun, hasModelFlag, extractBakedModel } from './runner.js';
import {
  PROMPT_FRAGMENT_MAX,
  STARTER_PROMPT_MAX,
} from './worldBuilder.js';

const MAX_FEEDBACK = 3000;
const MAX_RATIONALE = 1200;
const MAX_CHANGES = 8;

const trimTo = (value, max) =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

const cleanChanges = (changes) => (
  Array.isArray(changes)
    ? changes.map((c) => trimTo(c, 240)).filter(Boolean).slice(0, MAX_CHANGES)
    : []
);

// Same brace-walker as mediaPromptRefiner: Codex CLI echoes the prompt to
// stdout before the model response, and the prompt itself contains a JSON
// schema example whose braces balance but whose contents are placeholder
// text. Walk every brace-balanced block in order and return the first that
// looks like a refinement payload (object with a `starterPrompt` string).
const isPlaceholder = (s) => typeof s === 'string' && /^\s*<.+>\s*$/.test(s);

function extractRefinementJson(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('Empty AI response');
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();

  let i = 0;
  let lastErr;
  let placeholderSeen = false;
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
    if (end === -1) break;
    const block = s.slice(start, end + 1);
    try {
      const value = JSON.parse(block);
      if (value && typeof value === 'object' && typeof value.starterPrompt === 'string') {
        if (isPlaceholder(value.starterPrompt)) { placeholderSeen = true; }
        else return value;
      }
    } catch (e) { lastErr = e; }
    i = end + 1;
  }
  if (placeholderSeen) {
    throw new Error('AI returned the schema placeholder instead of a real refinement — try a stronger model or rerun');
  }
  throw new Error(`Invalid JSON in AI response${lastErr ? `: ${lastErr.message}` : ''}`);
}

export function buildWorldRefinePrompt({ starterPrompt, stylePrompt, negativePrompt, feedback }) {
  return `You are a senior world-building prompt editor for a Stable-Diffusion-style image-generation pipeline.

The user has three top-level prompts that define a "world": a STARTER IDEA (the high-concept seed), a STYLE PROMPT (visual style fragment prepended to every render — palette, lighting, render quality, artist references), and a NEGATIVE PROMPT (tokens to avoid). They have given feedback about the story concept, mood, style, design, or any aspect of the world they want refined.

Rewrite all three prompts so they more faithfully express the user's intention. Output the COMPLETE rewritten text for each — not a placeholder, not a summary, not a diff.

Return ONLY valid JSON in this schema (replace every <…> with real content; do NOT output the literal angle-bracket text):
{
  "starterPrompt": "<full rewritten high-concept starter idea, 1-3 sentences, ready to feed back into the world expander>",
  "stylePrompt": "<full rewritten style fragment, comma-separated tokens, no subject nouns — palette, lighting, render quality, artist references>",
  "negativePrompt": "<full rewritten negative prompt, comma-separated tokens to avoid; empty string if none>",
  "rationale": "<one concise sentence explaining the overall edit>",
  "changes": ["<short bullet of what changed and why>"]
}

Rules:
- Preserve story/character/world DNA from the originals unless the user's feedback explicitly contradicts it.
- The "starterPrompt" should remain a seed — the high-concept hook the world expander will fan out into categories. Do not list category content (landscapes, factions, etc.) here.
- The "stylePrompt" must be comma-separated visual-style tokens only. No subject nouns. No camera/aspect tokens. Under 400 characters.
- The "negativePrompt" must be comma-separated tokens. If the world relies on text/typography (e.g. pitch posters), avoid putting "text" in negatives — prefer "watermark, logo, unreadable tiny text, text artifacts".
- Apply the user's feedback decisively. If they ask for a different style/mood/era, move toward it in the style prompt AND name the things to avoid in the negative prompt.
- The "starterPrompt" field must NEVER equal the schema placeholder text — it must be the actual rewritten seed.

ORIGINAL STARTER IDEA:
${starterPrompt || '(empty)'}

ORIGINAL STYLE PROMPT:
${stylePrompt || '(empty)'}

ORIGINAL NEGATIVE PROMPT:
${negativePrompt || '(empty)'}

USER FEEDBACK:
${feedback}`;
}

// CLI providers (codex/claude-code/gemini-cli) need provider-specific arg
// shapes that the toolkit runner already knows about — going through the
// runner avoids the "stdin is not a terminal" failure mode that hits when
// you spawn `codex` directly without the `exec -` invocation.
async function runRefine(provider, model, prompt) {
  const { runId } = await createRun({
    providerId: provider.id,
    model,
    prompt,
    source: 'world-builder-refine',
  });

  let text = '';
  return new Promise((resolve, reject) => {
    const onData = (chunk) => { text += typeof chunk === 'string' ? chunk : (chunk?.text || ''); };
    const onComplete = (result) => {
      if (result?.error || result?.success === false) {
        reject(new ServerError(result?.error || 'World refinement failed', { status: 502, code: 'WORLD_REFINE_FAILED' }));
      } else {
        resolve({ text, runId });
      }
    };
    if (provider.type === 'cli') {
      // Mirror the media refiner: `buildCliArgs` now honors a per-call model
      // override (via `provider.defaultModel`) for codex / claude-code /
      // gemini-cli. Clone the provider with the overridden defaultModel
      // whenever the caller picked something other than the saved default.
      const providerForCli = model && model !== provider.defaultModel
        ? { ...provider, defaultModel: model }
        : provider;
      executeCliRun(runId, providerForCli, prompt, process.cwd(), onData, onComplete, provider.timeout ?? 300000).catch(reject);
    } else {
      executeApiRun(runId, provider, model, prompt, process.cwd(), [], onData, onComplete).catch(reject);
    }
  });
}

/**
 * Refine the 3 top-level world prompts.
 *
 * @param {object} args
 * @param {string} args.starterPrompt   — original
 * @param {string} [args.stylePrompt]   — original (may be empty)
 * @param {string} [args.negativePrompt] — original (may be empty)
 * @param {string} args.feedback        — required user feedback
 * @param {string} [args.providerId]    — overrides the active provider
 * @param {string} [args.model]         — overrides the provider's default model
 */
export async function refineWorldPrompts({
  starterPrompt,
  stylePrompt = '',
  negativePrompt = '',
  feedback,
  providerId,
  model,
} = {}) {
  if (!feedback || !feedback.trim()) {
    throw new ServerError('Feedback is required', { status: 400, code: 'FEEDBACK_REQUIRED' });
  }
  if (!starterPrompt || !starterPrompt.trim()) {
    throw new ServerError('Starter prompt is required to refine', { status: 400, code: 'STARTER_REQUIRED' });
  }

  let provider = providerId ? await getProviderById(providerId).catch(() => null) : null;
  if (!provider) provider = await getActiveProvider();
  if (!provider) {
    throw new ServerError('No AI provider available for world refinement', { status: 400, code: 'NO_PROVIDER' });
  }
  if (provider.enabled === false) {
    throw new ServerError(
      `Provider "${provider.name || provider.id}" is disabled — enable it in Settings → Providers first`,
      { status: 400, code: 'PROVIDER_DISABLED' },
    );
  }

  // API providers honor per-call `model` directly; CLI providers do too via
  // buildCliArgs (which injects --model/-m from provider.defaultModel),
  // unless the user has hard-coded a model flag into provider.args — in
  // that case the saved arg wins and we surface the model id parsed out of
  // args so the response/run record matches what'll actually run.
  const cliHasBakedModelFlag = provider.type === 'cli' && hasModelFlag(provider.args);
  const honorsModelOverride = provider.type === 'api' || (provider.type === 'cli' && !cliHasBakedModelFlag);
  const bakedModel = cliHasBakedModelFlag ? extractBakedModel(provider.args) : null;
  const selectedModel = honorsModelOverride
    ? (model || provider.defaultModel || provider.models?.[0] || '')
    : (bakedModel || provider.defaultModel || provider.models?.[0] || '');
  if (!selectedModel && provider.type === 'api') {
    throw new ServerError('Model is required for world refinement', { status: 400, code: 'MODEL_REQUIRED' });
  }

  const llmPrompt = buildWorldRefinePrompt({
    starterPrompt: trimTo(starterPrompt, STARTER_PROMPT_MAX),
    stylePrompt: trimTo(stylePrompt, PROMPT_FRAGMENT_MAX),
    negativePrompt: trimTo(negativePrompt, PROMPT_FRAGMENT_MAX),
    feedback: trimTo(feedback, MAX_FEEDBACK),
  });

  const { text, runId } = await runRefine(provider, selectedModel, llmPrompt);

  let parsed;
  try {
    parsed = extractRefinementJson(text || '');
  } catch (e) {
    console.warn(`⚠️ world-refine [${provider.id}/${selectedModel || 'default'} runId=${runId}] parse failed: ${e.message} (response size: ${(text || '').length} chars)`);
    throw new ServerError(e.message, { status: 502, code: 'WORLD_REFINE_BAD_JSON' });
  }

  const refinedStarter = trimTo(parsed.starterPrompt, STARTER_PROMPT_MAX);
  if (!refinedStarter) {
    throw new ServerError('LLM returned an empty starter prompt', { status: 502, code: 'WORLD_REFINE_EMPTY_STARTER' });
  }

  return {
    starterPrompt: refinedStarter,
    stylePrompt: trimTo(parsed.stylePrompt, PROMPT_FRAGMENT_MAX),
    negativePrompt: trimTo(parsed.negativePrompt, PROMPT_FRAGMENT_MAX),
    rationale: trimTo(parsed.rationale, MAX_RATIONALE),
    changes: cleanChanges(parsed.changes),
    providerId: provider.id,
    model: selectedModel,
  };
}

export const __testing = { extractRefinementJson, buildWorldRefinePrompt };
