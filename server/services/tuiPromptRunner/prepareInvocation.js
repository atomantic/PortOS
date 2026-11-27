/** Prepare the one-shot provider invocation, workspace and wrapped prompt. */
import { basename, isAbsolute, join, resolve } from 'path';
import { access } from 'node:fs/promises';
import { ensureDir, PATHS } from '../../lib/fileUtils.js';
import { runOwnership } from '../../lib/aiToolkit/internal/runOwnership.js';
import { buildTuiInvocation, DEFAULT_TUI_PROMPT_DELAY_MS } from '../../lib/tuiHandshake.js';
import { isCodexCommand } from '../../lib/codex.js';
import { applyCredentialBootstrap, needsProcessGroup } from '../../lib/credentialBootstrap.js';
import { getRunsPath, patchRunMetadata, resolveRunCwd } from '../runner.js';

// One-shot idle and wall-clock bounds differ from the long-running agent policy.
const DEFAULT_TIMEOUT_MS = 300000;
const DEFAULT_ONE_SHOT_IDLE_MS = 8000;

// A machine-consumed answer must fit one request budget even if interactive Codex enables multi-agent mode.
function buildOneShotTuiArgs(command, args) {
  if (!isCodexCommand(command)) return args;
  const alreadyDisabled = args.some((arg, index) => (
    arg === '--disable=multi_agent'
    || (arg === '--disable' && args[index + 1] === 'multi_agent')
    || (arg === '-c' && args[index + 1] === 'features.multi_agent=false')
  ));
  return alreadyDisabled ? args : [...args, '--disable', 'multi_agent'];
}

export async function prepareInvocation({
  runId, provider, prompt, screenshots = [], workspacePath,
  timeout, idleMs, onData, onComplete, reportFailure = true,
}) {
  if (!provider || typeof provider !== 'object') {
    throw new Error('executeTuiRun: provider is required');
  }
  if (typeof prompt !== 'string' || !prompt) {
    throw new Error('executeTuiRun: prompt must be a non-empty string');
  }

  if (provider.executionOptions && !provider.executionOptionAttribution) {
    const { prepareExecutionOptions } = await import('../../lib/provider/providerExecutionOptions.js');
    const prepared = await prepareExecutionOptions(provider, provider.defaultModel, undefined, 'provider', { cwd: workspacePath });
    provider = prepared.provider;
    await patchRunMetadata(runId, { executionOptions: prepared.attribution, model: prepared.provider.defaultModel });
  }
  await patchRunMetadata(runId, runOwnership('tui'));
  const invocation = buildTuiInvocation(provider, provider.defaultModel);
  const { command } = invocation;
  const args = buildOneShotTuiArgs(command, invocation.args);
  if (screenshots.length > 0) {
    if (!isCodexCommand(command)) throw new Error('This TUI provider cannot receive image attachments');
    for (const screenshot of screenshots) {
      if (typeof screenshot !== 'string' || !screenshot) throw new Error('Invalid screenshot path');
      const imagePath = isAbsolute(screenshot) ? screenshot : resolve(PATHS.screenshots, basename(screenshot));
      await access(imagePath);
      args.push('--image', imagePath);
    }
  }
  // Keep the harness identity for readiness and recovery even when a separate credential wrapper launches it.
  const { command: spawnCommand, args: spawnArgs, wrapped } = applyCredentialBootstrap(provider, command, args);
  const promptDelayMs = provider.tuiPromptDelayMs ?? DEFAULT_TUI_PROMPT_DELAY_MS;
  const idleThresholdMs = idleMs ?? provider.tuiOneShotIdleMs ?? DEFAULT_ONE_SHOT_IDLE_MS;
  const totalTimeoutMs = timeout ?? provider.timeout ?? DEFAULT_TIMEOUT_MS;
  // Codex can reason silently for minutes. Codex and unbounded runs need a file, exit or explicit stop.
  const requiresResponseFileForIdleCompletion = totalTimeoutMs === 0 || isCodexCommand(command);
  // Use the caller’s configured run directory for both metadata and response output.
  const runDir = join(getRunsPath(), runId);
  await ensureDir(runDir);

  // Finalization can race missing createRun metadata. Give it the same identity as the start event.
  const runIdentity = {
    providerId: provider.id,
    providerName: provider.name || provider.id,
    model: provider.defaultModel,
  };

  // Resolve the workspace after creating the directory where a failure must be recorded.
  const { cwd: workingDir, failure } = await resolveRunCwd({
    runId, workspacePath, label: `TUI run ${runId}`, onData, onComplete, identity: runIdentity, reportFailure,
  });
  if (failure) return { failure };

  // The spawned cwd may differ from the server cwd. Supply the absolute path to the authoritative answer file.
  const responseFilePath = resolve(runDir, 'tui-response.txt');
  const wrappedPrompt = `IMPORTANT — Output to file:
When you have completed the task below, write your COMPLETE final response (and nothing else — no commentary, preamble, or wrapper text) to this exact absolute path using your file-writing tool:

    ${responseFilePath}

Only the contents of that file will be used as your response, so do not print the response inline. Once the file is written, you can finish.

----- TASK -----

${prompt}`;

  console.log(`📟 Executing TUI: ${command} ${args.join(' ')} (${wrappedPrompt.length} chars via paste, response→${responseFilePath})`);

  return {
    provider, command, args, spawnCommand, spawnArgs, processGroup: needsProcessGroup(wrapped), workingDir,
    runIdentity, promptDelayMs, idleThresholdMs, totalTimeoutMs, requiresResponseFileForIdleCompletion,
    wrappedPrompt, responseFilePath,
  };
}
