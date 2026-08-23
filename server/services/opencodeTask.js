/**
 * Run one bounded task through an OpenCode provider preset — the shared
 * structured task driver.
 *
 * Two features need this: the runtime agent-task benchmark
 * (`localModelAgentBenchmark.js`) and the sandbox-repair capability test
 * (`modelCapabilityTests.js`). Both want the same thing — point a configured
 * local OpenCode preset at a directory, give it a prompt, and read back what its
 * tool loop did — and both previously carried a character-for-character copy of
 * the argv, the env composition and the spawn. That is two places to fix the
 * next time OpenCode changes a flag, which it has done before.
 *
 * Line-streaming rather than run-and-collect: the capability test renders the
 * transcript live while the agent works, and `lib/streamingSpawn.js` is the
 * helper that owns that lane (`bufferedSpawn` is its run-and-collect sibling).
 * Streaming also means there is exactly ONE parse of the stream — the aggregated
 * events and the live view can never disagree about what happened.
 */

import { ServerError } from '../lib/errorHandler.js';
import { runStreamingCommand } from '../lib/streamingSpawn.js';
import { prepareCliSpawn } from '../lib/bufferedSpawn.js';
import { buildCliChildEnv } from '../lib/cliChildEnv.js';
import { isOpencodeCommand, prefixOpencodeModel, getOpencodeLocalProviderNamespace } from '../lib/providerModels.js';
import { parseAgentLine } from '../lib/opencodeStream.js';
import { listProviders } from './providers.js';

/**
 * The configured OpenCode TUI provider preset that drives a given local runtime.
 *
 * Matched on the provider's own `*Backed` marker rather than a hardcoded id
 * list, so renaming or adding a preset keeps working. LM Studio has no OpenCode
 * namespace at all, which is why a caller must handle "none configured" as a
 * real answer rather than a failure to look harder.
 *
 * @param {string} runtime a local runtime id (`llama`, `ollama`, `mtplx`, …)
 * @param {Array<object>} [providers] the already-loaded RECORDS (see
 *   `listProviders`), passed in when resolving several runtimes at once so the
 *   list is read once rather than per runtime.
 */
export async function resolveOpencodeTuiProvider(runtime, providers) {
  const list = Array.isArray(providers) ? providers : await listProviders();
  return list.find((p) => p?.type === 'tui'
    && isOpencodeCommand(p.command)
    && getOpencodeLocalProviderNamespace(p) === runtime) || null;
}

/**
 * Drive one disposable OpenCode task to completion through its JSON task
 * interface. The PTY-backed TUI path is measured by the separate local harness
 * benchmark; keeping this driver structured makes disk-verifiable capability
 * scoring and live tool-event rendering deterministic.
 *
 * @param {object} options
 * @param {object} options.provider a TUI provider record (validated here)
 * @param {string} options.modelId model as the RUNTIME names it; the OpenCode
 *   namespace prefix is applied here so a bare id can never route to a cloud
 *   provider by accident
 * @param {string} options.cwd the directory the agent works in
 * @param {string} options.prompt
 * @param {number} options.timeoutMs
 * @param {AbortSignal} [options.signal] caller disconnect/cancel signal
 * @param {(event: object) => void} [options.onEvent] called with each parsed
 *   stream frame as it arrives, for a caller rendering live progress
 * @returns {Promise<{success: boolean, error: string|null, events: object[]}>}
 *   never rejects for an in-run failure — the caller gets a value to score.
 */
export async function runOpencodeTask({ provider, modelId, cwd, prompt, timeoutMs, signal, onEvent }) {
  if (!provider) {
    throw new ServerError('No OpenCode TUI provider was given', { status: 503, code: 'OPENCODE_TASK_PROVIDER_MISSING' });
  }
  if (provider.type !== 'tui' || !isOpencodeCommand(provider.command)) {
    throw new ServerError(`Provider "${provider.id}" is not an OpenCode TUI provider`, {
      status: 503, code: 'OPENCODE_TASK_PROVIDER_INVALID',
    });
  }

  const events = [];
  const qualifiedModel = prefixOpencodeModel(provider, modelId);
  const baseArgs = Array.isArray(provider.args) ? provider.args : [];
  const args = ['run', '--format', 'json', '--auto', '--dir', cwd, ...baseArgs, '--model', qualifiedModel, prompt];
  // Pins PWD to `cwd` (#3193) — OpenCode resolves its project root from PWD, so
  // an inherited one would silently run the task in the PortOS checkout.
  const env = buildCliChildEnv({ provider, model: modelId, cwd, guard: true });
  const spawnTarget = prepareCliSpawn(provider.command, args, env);

  const result = await runStreamingCommand(spawnTarget.command, spawnTarget.args, (line) => {
    const event = parseAgentLine(line);
    if (!event) return;
    events.push(event);
    // Hook failures are already caught by runStreamingCommand — this runs
    // outside the request lifecycle, where a throw would take the process down.
    onEvent?.(event);
  }, { cwd, env, timeoutMs, isCancelled: () => signal?.aborted === true });

  return { success: result.success, error: result.error || null, events };
}
