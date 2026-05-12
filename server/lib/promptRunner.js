/**
 * Shared LLM runner wrapper.
 *
 * Four near-identical implementations of "create run → branch on
 * provider.type → executeCliRun/executeApiRun → accumulate streamed text
 * → reject on error" had drifted in failure-handling:
 *
 *   - worldBuilderExpand#callLLM        — CLI: `error || success === false`, API: `error` only
 *   - stageRunner#awaitRunnerCall       — CLI: `error || success === false`, API: `error` only
 *   - mediaPromptRefiner#runRefinePrompt — both: `error || success === false`
 *   - messageEvaluator#runPrompt        — CLI: `error || success === false`, API: `error` only
 *
 * This unified runner picks the strictest discriminator: reject on
 * `success === false` OR truthy `error` for BOTH CLI and API. The
 * per-site drift was the bug — silent API "soft failures" (e.g. an
 * empty completion that doesn't set `error` but does set
 * `success: false`) used to flow through as a successful empty string.
 *
 * Returns `{ text, runId, model }`. `text` is the full streamed body;
 * `runId` is the persisted run id so callers can log it and surface
 * data/runs/<runId>/output.txt for offline debugging; `model` is the
 * effective model that actually executed after the per-provider
 * override gate (null when neither the caller's model nor
 * provider.defaultModel applies). Callers should log/return THIS
 * `model`, not the value they passed in, so logs and run records
 * stay honest about what the runner actually executed.
 */

import { createRun, executeApiRun, executeCliRun } from '../services/runner.js';

const DEFAULT_TIMEOUT_MS = 300000;
const APPEND_CHUNK = (acc, chunk) => acc + (typeof chunk === 'string' ? chunk : (chunk?.text || ''));

/**
 * Returns true when the runner+provider pair will actually honor a
 * per-call `model` override. For API providers the model is a
 * first-class arg to `executeApiRun`. For CLI providers,
 * `runner.js#buildCliArgs` currently only translates the resolved
 * `defaultModel` into a `--model` flag for codex; claude-code and
 * gemini-cli ignore it and run with whatever model is baked into
 * `provider.args`. PLAN.md tracks extending buildCliArgs to all
 * CLI providers — once that lands this predicate widens.
 */
export const providerHonorsModelOverride = (provider) =>
  provider?.type === 'api' || provider?.id === 'codex';

/**
 * Run a prompt through a provider and resolve with the streamed text +
 * run id. Rejects (via the strictest discriminator) on any runner-
 * reported failure.
 *
 * Per-call `model` overrides are silently dropped for providers that
 * don't honor them (see `providerHonorsModelOverride`). This keeps the
 * persisted run record honest about which model actually ran — passing
 * the user's selection downstream when the runner can't apply it would
 * make `/runs` and SSE status events lie about model usage.
 *
 * @param {object} args
 * @param {object} args.provider — { id, type: 'cli'|'api', timeout?, ... }
 * @param {string} args.prompt   — full text to send to the LLM
 * @param {string} args.source   — run-record tag (`'world-builder-expansion'`,
 *   `'media-prompt-refine'`, `'messages-triage'`, `'staged-llm'`, etc.)
 * @param {string} [args.model]  — model id hint; ignored when the
 *   provider doesn't honor it (claude-code, gemini-cli today).
 * @param {string} [args.runId]  — caller-supplied run id (skip createRun
 *   round-trip when the caller has already created the run)
 * @returns {Promise<{ text: string, runId: string, model: string|null }>}
 *   — `model` is the resolved model that actually executed (null when
 *   neither override nor provider.defaultModel applies).
 */
export async function runPromptThroughProvider({ provider, prompt, source, model, runId: callerRunId }) {
  // Resolve the model that'll actually run BEFORE creating the run record
  // so the record reflects reality. For providers that don't honor the
  // override, fall back to provider.defaultModel / models[0].
  const effectiveModel = providerHonorsModelOverride(provider)
    ? (model || provider.defaultModel || provider.models?.[0] || null)
    : (provider.defaultModel || provider.models?.[0] || null);

  // Some call sites (stageRunner) create the run themselves so they can
  // log the runId before the LLM call starts. When provided, reuse it.
  // Otherwise create one here so callers always get a runId back.
  const runId = callerRunId || (await createRun({
    providerId: provider.id,
    model: effectiveModel,
    prompt,
    source,
  })).runId;

  return new Promise((resolve, reject) => {
    let text = '';
    const onData = (chunk) => { text = APPEND_CHUNK(text, chunk); };
    // Strictest discriminator: reject on either truthy `error` OR
    // explicit `success === false`. Per-site drift was the bug.
    const onComplete = (result) => {
      if (result?.error || result?.success === false) {
        reject(new Error(result?.error || `${provider.type === 'cli' ? 'CLI' : 'API'} execution failed`));
      } else {
        resolve({ text, runId, model: effectiveModel });
      }
    };

    if (provider.type === 'cli') {
      // executeCliRun reads `provider.defaultModel` for both the CLI
      // args and the run-started metadata hook. Hand it a clone with
      // effectiveModel in defaultModel so codex's --model flag picks
      // up the override AND the hook reports the right model. For
      // non-codex CLIs effectiveModel === provider.defaultModel
      // (resolved above), so the clone is a no-op.
      const providerForCli = effectiveModel && effectiveModel !== provider.defaultModel
        ? { ...provider, defaultModel: effectiveModel }
        : provider;
      executeCliRun(
        runId,
        providerForCli,
        prompt,
        process.cwd(),
        onData,
        onComplete,
        providerForCli.timeout ?? DEFAULT_TIMEOUT_MS,
      ).catch(reject);
    } else if (provider.type === 'api') {
      executeApiRun(
        runId,
        provider,
        effectiveModel,
        prompt,
        process.cwd(),
        [],
        onData,
        onComplete,
      ).catch(reject);
    } else {
      reject(new Error(`Unsupported provider type: ${provider.type}`));
    }
  });
}
