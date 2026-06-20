import { runStagedLLM } from '../../lib/stageRunner.js';
import { ServerError } from '../../lib/errorHandler.js';

// Pass `logTag: null` to suppress the default runId log so a caller that
// needs a context-rich line (e.g. universeCharacterExpand wants the
// field-count) can emit its own after the post-merge state is known.
export async function runPromptRefineRaw({
  templateName,
  variables,
  options = {},
  source,
  logTag,
  emptyError = { code: 'PIPELINE_PROMPT_REFINE_EMPTY', message: 'LLM returned an empty payload' },
  validateContent,
}) {
  const result = await runStagedLLM(templateName, variables, {
    providerOverride: options.providerId,
    modelOverride: options.model,
    returnsJson: true,
    source,
  });
  const content = result.content;
  // Reject array AND non-object — `typeof [] === 'object'` would otherwise
  // let an LLM that returned `[{...}]` slip through downstream merges as a
  // valid-but-empty payload (no string keys match) and silently no-op.
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    throw new ServerError(emptyError.message, { status: 502, code: emptyError.code });
  }
  if (validateContent) validateContent(content);
  const rationale = typeof content.rationale === 'string' ? content.rationale.trim() : '';
  if (logTag) {
    console.log(`✨ ${logTag} runId=${(result.runId || '').slice(0, 8)}`);
  }
  return { content, rationale, runId: result.runId, providerId: result.providerId, model: result.model };
}

// Normalize an LLM-returned `changes` array (the short "what I changed" bullet
// list every refine prompt emits) to trimmed, non-empty, capped strings. Shared
// by the raw-refine callers (arc / reader-map) that hand-rolled this identically;
// `runPromptRefine` applies the same shape inline via `changesLimit`.
export function trimChanges(raw, limit = 12) {
  return Array.isArray(raw)
    ? raw.map((c) => String(c).slice(0, 240)).filter(Boolean).slice(0, limit)
    : [];
}

// Upper bound on how many image-prompt candidates a single fan-out request
// may ask for. Each candidate is an independent LLM call, so the cap keeps a
// runaway `count` from spawning dozens of provider hits in one click.
export const IMAGE_PROMPT_CANDIDATE_MAX = 6;

// Fan-out wrapper around `runPromptRefine`: run the same refine template N
// times in parallel and collect the distinct candidate prompts. Sampling
// variance across the independent calls yields N different image-gen prompts
// from one script fragment (issue #904). Partial failure is tolerated — a few
// provider hiccups still return the survivors; only an all-failed batch throws
// (surfacing the first underlying error so the caller sees the real cause).
export async function runImagePromptCandidates({
  count,
  templateName,
  variables,
  options = {},
  source,
  logTag,
}) {
  const n = Math.min(Math.max(Math.trunc(Number(count) || 1), 1), IMAGE_PROMPT_CANDIDATE_MAX);
  const settled = await Promise.allSettled(
    Array.from({ length: n }, () => runPromptRefine({ templateName, variables, options, source })),
  );
  const candidates = [];
  let firstError = null;
  for (const r of settled) {
    if (r.status === 'fulfilled') {
      const { refined, changes, runId, providerId, model } = r.value;
      candidates.push({ prompt: refined, changes, runId, providerId, model });
    } else if (!firstError) {
      firstError = r.reason;
    }
  }
  if (!candidates.length) {
    throw firstError || new ServerError('LLM returned no image-prompt candidates', {
      status: 502, code: 'PIPELINE_IMAGE_PROMPTS_EMPTY',
    });
  }
  if (logTag) {
    console.log(`✨ ${logTag} candidates=${candidates.length}/${n}`);
  }
  return { candidates, requested: n };
}

// Single-field refine wrapper for the comic-panel / storyboard-scene /
// character-physicalDescription paths. `resultField` keeps the helper
// prompt-agnostic; `changes` are trimmed + capped on the way out.
export async function runPromptRefine({
  resultField = 'prompt',
  emptyError = { code: 'PIPELINE_PROMPT_REFINE_EMPTY', message: 'LLM returned an empty refined prompt' },
  changesLimit = 8,
  ...rest
}) {
  const validateContent = (c) => {
    // Type-gate: an LLM that returned `{ prompt: 42 }` or `{ prompt: { ... } }`
    // would otherwise blow up on `.trim()` or silently coerce to garbage. Treat
    // any non-string as missing.
    const raw = c?.[resultField];
    const refined = typeof raw === 'string' ? raw.trim() : '';
    if (!refined) {
      throw new ServerError(emptyError.message, { status: 502, code: emptyError.code });
    }
  };
  const { content, ...meta } = await runPromptRefineRaw({ ...rest, validateContent, emptyError });
  // `validateContent` already guarantees a non-empty string at this index.
  const refined = content[resultField].trim();
  const changes = Array.isArray(content.changes)
    ? content.changes.map((c) => String(c).slice(0, 240)).filter(Boolean).slice(0, changesLimit)
    : [];
  return { refined, changes, ...meta };
}
