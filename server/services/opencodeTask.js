/**
 * Run one bounded task through an OpenCode provider preset: the shared structured
 * task driver for the agent-task benchmark (`localModelAgentBenchmark.js`) and the
 * sandbox-repair capability test (`modelCapabilityTests.js`).
 *
 * Line-streaming (`lib/streamingSpawn.js`) so the capability test renders the
 * transcript live and there is exactly ONE parse of the stream.
 */

import { resolveSplashHarnessContext } from '../lib/splashHarnessLaunch.js';
import { ServerError } from '../lib/errorHandler.js';
import { runStreamingCommand } from '../lib/streamingSpawn.js';
import { prepareCliSpawn } from '../lib/bufferedSpawn.js';
import { applyCredentialBootstrap, needsProcessGroup } from '../lib/credentialBootstrap.js';
import { buildCliChildEnv } from '../lib/cliChildEnv.js';
import { isOpencodeCommand, prefixOpencodeModel, getOpencodeLocalProviderNamespace } from '../lib/provider/providerModels.js';
import { parseAgentLine } from '../lib/opencodeStream.js';
import { listProviders } from './provider/providers.js';

/**
 * The configured OpenCode TUI provider preset that drives a given local runtime,
 * matched on the provider's own `*Backed` marker rather than an id list. LM Studio
 * has no OpenCode namespace, so callers must treat "none configured" as an answer.
 *
 * @param {string} runtime a local runtime id (`llama`, `ollama`, `mtplx`, ...)
 * @param {Array<object>} [providers] already-loaded RECORDS (see `listProviders`),
 *   passed when resolving several runtimes so the list is read once.
 */
export async function resolveOpencodeTuiProvider(runtime, providers) {
  const list = Array.isArray(providers) ? providers : await listProviders();
  return list.find((p) => p?.type === 'tui'
    && isOpencodeCommand(p.command)
    && getOpencodeLocalProviderNamespace(p) === runtime) || null;
}

/**
 * Drive one disposable OpenCode task to completion through its JSON task
 * interface (the PTY TUI path is measured by the separate harness benchmark).
 *
 * @param {object} options
 * @param {object} options.provider a TUI provider record (validated here)
 * @param {string} options.modelId model as the RUNTIME names it; the OpenCode
 *   namespace prefix is applied here so a bare id cannot route to a cloud provider
 * @param {string} options.cwd the directory the agent works in
 * @param {string} options.prompt
 * @param {number} options.timeoutMs
 * @param {AbortSignal} [options.signal] caller disconnect/cancel signal
 * @param {(event: object) => void} [options.onEvent] called with each parsed
 *   stream frame as it arrives
 * @returns {Promise<{success: boolean, error: string|null, events: object[]}>}
 *   never rejects for an in-run failure.
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
  // Pins PWD to `cwd` (#3193): OpenCode resolves its project root from PWD.
  const env = buildCliChildEnv({ provider: await resolveSplashHarnessContext(provider, modelId), model: modelId, cwd, guard: true });
  // Credential-bootstrap wrap first (credentialBootstrap.js), then shim resolution.
  const bootstrapped = applyCredentialBootstrap(provider, provider.command, args);
  const spawnTarget = prepareCliSpawn(bootstrapped.command, bootstrapped.args, env);
  // A bootstrap-wrapped child is the WRAPPER, so timeout/cancel must signal the
  // whole process group or the harness outlives the task (#7496).
  const processGroup = needsProcessGroup(bootstrapped.wrapped);

  const result = await runStreamingCommand(spawnTarget.command, spawnTarget.args, (line) => {
    const event = parseAgentLine(line);
    if (!event) return;
    events.push(event);
    // runStreamingCommand catches hook failures; a throw here would crash the process.
    onEvent?.(event);
  }, { cwd, env, timeoutMs, processGroup, isCancelled: () => signal?.aborted === true });

  return { success: result.success, error: result.error || null, events };
}
