import { ServerError } from '../lib/errorHandler.js';
import { getProviderById } from './providers.js';
import { createRun, executeApiRun, executeCliRun } from './runner.js';

const MAX_PROMPT_LEN = 8000;
const MAX_REASON_LEN = 1200;
const MAX_CHANGES = 8;

const trimString = (value, max = MAX_PROMPT_LEN) =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

const cleanChanges = (changes) => (
  Array.isArray(changes)
    ? changes.map((c) => trimString(c, 240)).filter(Boolean).slice(0, MAX_CHANGES)
    : []
);

// The prompt template uses `<...>` markers for every field placeholder. If a
// JSON block's `prompt` is still wrapped in angle brackets, the model parroted
// the schema example back instead of producing a real refinement — skip it so
// Codex's habit of replaying its stdin to stdout doesn't poison the result.
const isPlaceholderPrompt = (s) => typeof s === 'string' && /^\s*<.+>\s*$/.test(s);

// Codex CLI prepends a banner like `OpenAI Codex CLI...` and `[workdir, /…]`
// metadata before the model's JSON output, AND echoes the input prompt to
// stdout (which contains the schema example {…}). Walk braces with string-
// awareness, skip any block whose `prompt` is a placeholder, and return the
// first remaining block that parses as an object with a `prompt` field.
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
    for (let j = start; j < s.length; j++) {
      const ch = s[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { end = j; break; }
      }
    }
    if (end === -1) break;
    const block = s.slice(start, end + 1);
    try {
      const value = JSON.parse(block);
      if (value && typeof value === 'object' && typeof value.prompt === 'string') {
        if (isPlaceholderPrompt(value.prompt)) { placeholderSeen = true; }
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

export function buildMediaPromptRefinePrompt({ kind, prompt, negativePrompt, feedback, renderConfig = {} }) {
  const kindLabel = kind === 'video' ? 'video' : 'image';
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
- The "prompt" field must NEVER equal the schema placeholder text — it must be the actual rewritten render prompt.

ORIGINAL POSITIVE PROMPT:
${prompt || '(empty)'}

ORIGINAL NEGATIVE PROMPT:
${negativePrompt || '(empty)'}

RENDER CONFIG (kind=${kind}):
${JSON.stringify(renderConfig, null, 2)}

USER FEEDBACK:
${feedback}`;
}

// CLI providers (codex/claude-code/gemini-cli) need provider-specific arg
// shapes that the toolkit runner already knows about — going through the
// runner avoids the "stdin is not a terminal" failure mode that hits when
// you spawn `codex` directly without the `exec -` invocation.
async function runRefinePrompt(provider, model, prompt) {
  const { runId } = await createRun({
    providerId: provider.id,
    model,
    prompt,
    source: 'media-prompt-refine',
  });

  let text = '';
  return await new Promise((resolve, reject) => {
    const onData = (chunk) => { text += typeof chunk === 'string' ? chunk : (chunk?.text || ''); };
    const onComplete = (result) => {
      if (result?.error || result?.success === false) {
        reject(new ServerError(result?.error || 'Prompt refinement failed', { status: 502, code: 'PROMPT_REFINE_FAILED' }));
      } else {
        resolve({ text, runId });
      }
    };
    if (provider.type === 'cli') {
      // `runner.js#buildCliArgs` only translates `provider.defaultModel` into
      // a `--model` flag for `codex` today; `claude-code` and `gemini-cli`
      // ignore it and run with whatever model is baked into provider.args.
      // Override defaultModel only when it'll actually take effect — otherwise
      // we'd lie to the caller about which model ran. (PLAN.md tracks the
      // shared-infra fix to extend buildCliArgs to all CLI providers.)
      const canOverrideModel = provider.id === 'codex';
      const providerForCli = canOverrideModel && model && model !== provider.defaultModel
        ? { ...provider, defaultModel: model }
        : provider;
      executeCliRun(runId, providerForCli, prompt, process.cwd(), onData, onComplete, provider.timeout ?? 300000).catch(reject);
    } else {
      executeApiRun(runId, provider, model, prompt, process.cwd(), [], onData, onComplete).catch(reject);
    }
  });
}

export async function refineMediaPrompt({
  kind,
  prompt,
  negativePrompt = '',
  feedback,
  providerId,
  model,
  renderConfig = {},
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

  // Resolve the model that'll actually run. For API + Codex CLI, the runner
  // honors the per-call `model` override. For other CLI providers (claude-code,
  // gemini-cli), `runner.js#buildCliArgs` ignores per-call model and runs
  // whatever's baked into provider.args / provider.defaultModel — so reporting
  // the user-requested model in the response/run-record would lie about which
  // model produced the output. Fall back through defaultModel → models[0] for
  // those providers so the returned `model` reflects reality. (PLAN.md tracks
  // extending buildCliArgs to honor per-call model for all CLI providers.)
  const honorsModelOverride = provider.type === 'api' || provider.id === 'codex';
  const selectedModel = honorsModelOverride
    ? (model || provider.defaultModel || provider.models?.[0] || '')
    : (provider.defaultModel || provider.models?.[0] || '');
  if (!selectedModel && provider.type === 'api') {
    throw new ServerError('Model is required for prompt refinement', { status: 400, code: 'MODEL_REQUIRED' });
  }

  const llmPrompt = buildMediaPromptRefinePrompt({
    kind,
    prompt: trimString(prompt),
    negativePrompt: trimString(negativePrompt),
    feedback: trimString(feedback, 3000),
    renderConfig,
  });

  const { text, runId } = await runRefinePrompt(provider, selectedModel, llmPrompt);

  let parsed;
  try {
    parsed = extractRefinementJson(text || '');
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

  const refinedPrompt = trimString(parsed.prompt);
  if (!refinedPrompt) {
    throw new ServerError('LLM returned an empty prompt', { status: 502, code: 'PROMPT_REFINE_EMPTY_PROMPT' });
  }

  return {
    prompt: refinedPrompt,
    negativePrompt: trimString(parsed.negativePrompt),
    rationale: trimString(parsed.rationale, MAX_REASON_LEN),
    changes: cleanChanges(parsed.changes),
    providerId: provider.id,
    model: selectedModel,
  };
}
