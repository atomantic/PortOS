/**
 * Agent CLI Spawning
 *
 * Handles building spawn configurations, stream-json parsing, tool input
 * summarization, and Claude settings env injection for agent processes.
 */

import { join } from 'path';
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { spawn } from '../lib/childProcess.js';
import { homedir } from 'os';
import { cosEvents, emitLog } from './cosEvents.js';
// The DEFINING module, not a barrel (#3450) — see the note in
// `agentManagement.js`. This module is a LEAF that `agentLifecycle.js` imports,
// which puts it inside the facade's closure, so the facade is out of reach here.
import { updateAgent, completeAgent, createAgentOutputBatcher } from './cosAgentLifecycle.js';
import { release } from './executionLanes.js';
import { completeExecution, errorExecution } from './toolStateMachine.js';
import { analyzeAgentFailure } from './agentErrorAnalysis.js';
import { completeAgentRun } from './agentRunTracking.js';
import { finalizeAgent, releaseAgentLane } from './agentFinalization.js';
import { activeAgents, userTerminatedAgents, pausedAgents, registerSpawnedAgent, unregisterSpawnedAgent } from './agentState.js';
import { normalizeReviewers } from '../lib/validation.js';
import { resolveReviewLoopOptions } from './codeReview.js';
import { safeJSONParse, PATHS } from '../lib/fileUtils.js';
import { createCodexStderrFormatter } from '../lib/codexCliOutput.js';
import { PROVIDER_TYPES } from '../lib/aiToolkit/constants.js';
import { createImmediateFallbackSignalDetector } from '../lib/aiToolkit/errorDetection.js';
import { prepareCliPrompt } from '../lib/cliProviderArgs.js';
// buildCliSpawnConfig's per-vendor argv construction dispatches through the
// PROVIDER_VENDORS registry (#3618) instead of a hand-rolled per-vendor
// if-chain — see providerVendors.js for the vendor rows.
import { buildVendorSpawnConfig } from '../lib/providerVendors.js';
import { resolveCliModel, providerSuppliesGithubToken, isOllamaClaudeProvider } from '../lib/providerModels.js';
import { resolveForgeTokenEnv } from './git.js';
import { prepareCliSpawn, killProcessTree } from '../lib/bufferedSpawn.js';
import { buildCliChildEnv } from '../lib/cliChildEnv.js';
import { prClaimWasVerified, resolvePrCompletion, resolvePrCreation } from '../lib/prDisposition.js';
import { canTypeSlashCommands, agentOwnsPrWorkflow } from '../lib/slashdoInvocation.js';
import { doneSentinelPath } from '../lib/agentSentinel.js';
import { isHostShuttingDown, shouldAbandonForHostShutdown, HOST_SHUTDOWN_REASON } from '../lib/hostShutdown.js';

const AGENTS_DIR = PATHS.cosAgents;

/**
 * Summarize tool input into a concise description for display.
 * Extracts the most relevant parameter from each tool type.
 */
export function summarizeToolInput(toolName, input) {
  if (!input || typeof input !== 'object') return '';
  const shorten = (p) => {
    if (!p || typeof p !== 'string') return '';
    const parts = p.split('/').filter(Boolean);
    return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : p;
  };
  switch (toolName) {
    case 'Read':
      return shorten(input.file_path);
    case 'Edit':
      return shorten(input.file_path);
    case 'Write':
      return shorten(input.file_path);
    case 'Glob':
      return input.pattern || '';
    case 'Grep':
      return `"${(input.pattern || '').substring(0, 60)}"${input.path ? ` in ${shorten(input.path)}` : ''}`;
    case 'Bash': {
      const cmd = input.command || input.description || '';
      return cmd.substring(0, 80);
    }
    case 'Task':
      return input.description || '';
    case 'WebFetch':
      return shorten(input.url || '');
    case 'WebSearch':
      return `"${(input.query || '').substring(0, 60)}"`;
    case 'TodoWrite':
      return input.todos?.length ? `${input.todos.length} items` : '';
    case 'NotebookEdit':
      return shorten(input.notebook_path);
    case 'Skill':
      return input.skill || '';
    default:
      return '';
  }
}

export const safeParse = (str) => safeJSONParse(str, null);

/**
 * Create a Claude stream-json parser that extracts human-readable text from JSON stream events.
 * Returns a stateful parser with a `processChunk(data)` method that returns extracted text lines.
 * The parser handles:
 *   - content_block_delta: incremental text tokens as they stream
 *   - tool_use events: shows tool calls with input details (e.g. "🔧 Read …/services/api.js")
 *   - input_json_delta: accumulates tool input JSON for detailed summaries
 *   - content_block_stop: emits detailed tool summary when input is complete
 *   - result: final result text (used for output file)
 */
export function createStreamJsonParser() {
  let lineBuffer = '';
  let finalResult = '';
  let textBuffer = '';
  // Track text across all conversation turns so multi-step agents (e.g., task + /simplify)
  // preserve all summaries instead of only the final one
  const textSections = [];
  let currentTextSection = '';
  // Track active tool blocks by index for input accumulation
  const activeTools = new Map(); // index -> { name, inputJson }

  // Commit accumulated text as a section (called at result events and stream end).
  // The committed section represents an agent turn's final wrap-up.
  const commitSection = () => {
    const section = currentTextSection.trim();
    if (section) {
      textSections.push(section);
      currentTextSection = '';
    }
  };

  // At a tool-call boundary the accumulated text is interim narration ("Now let me…")
  // that gets superseded by whatever the agent says after the tool returns. Discard it
  // so only the final post-last-tool wrap-up survives into textSections.
  const discardSection = () => { currentTextSection = ''; };

  const processChunk = (rawData) => {
    const lines = [];
    lineBuffer += rawData;

    // Split on newlines - each JSON object is on its own line
    const parts = lineBuffer.split('\n');
    // Keep the last incomplete line in the buffer
    lineBuffer = parts.pop() || '';

    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;

      // Skip non-JSON lines (stderr mixed in, etc.)
      if (!trimmed.startsWith('{')) continue;
      const parsed = safeParse(trimmed);
      if (!parsed) continue;

      // Extract text from streaming deltas
      if (parsed.type === 'stream_event') {
        const event = parsed.event;
        if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          const text = event.delta.text;
          textBuffer += text;
          currentTextSection += text;
          // Emit complete lines for readability, accumulate partial
          const textLines = textBuffer.split('\n');
          textBuffer = textLines.pop() || '';
          for (const tl of textLines) {
            lines.push(tl);
          }
        }
        // Accumulate tool input JSON deltas
        if (event?.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
          const idx = event.index;
          const tool = activeTools.get(idx);
          if (tool) {
            tool.inputJson += event.delta.partial_json || '';
          }
        }
        // Track tool use start - record name and begin accumulating input
        if (event?.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
          const toolName = event.content_block.name || 'unknown';
          const idx = event.index;
          activeTools.set(idx, { name: toolName, inputJson: '' });
          lines.push(`🔧 Using ${toolName}...`);
          discardSection();
        }
        // When tool input is complete, emit a detailed summary line
        if (event?.type === 'content_block_stop') {
          const idx = event.index;
          const tool = activeTools.get(idx);
          if (tool) {
            if (tool.inputJson) {
              const input = safeParse(tool.inputJson);
              if (input) {
                const detail = summarizeToolInput(tool.name, input);
                if (detail) {
                  lines.push(`  → ${detail}`);
                }
              }
            }
            activeTools.delete(idx);
          }
        }
      }

      // Extract tool results from assistant messages
      if (parsed.type === 'assistant') {
        const content = parsed.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result' && typeof block.content === 'string') {
              const firstLine = block.content.split('\n')[0]?.substring(0, 200);
              if (firstLine) {
                lines.push(`  ↳ ${firstLine}`);
              }
            }
          }
        }
      }

      // Capture final result text for output file
      if (parsed.type === 'result') {
        if (textBuffer) {
          lines.push(textBuffer);
          textBuffer = '';
        }
        commitSection();
        finalResult = parsed.result || '';
      }
    }

    return lines;
  };

  const flush = () => {
    const lines = [];
    if (textBuffer) {
      lines.push(textBuffer);
      textBuffer = '';
    }
    commitSection();
    return lines;
  };

  // Multi-section: return all text turns combined (e.g., task summary + simplify summary)
  // Single-section: return the CLI result field (cleaner, no tool call noise)
  const getFinalResult = () => {
    if (textSections.length > 1) {
      return textSections.join('\n\n');
    }
    return finalResult;
  };

  return { processChunk, flush, getFinalResult };
}

/**
 * Build spawn command and arguments for a CLI provider.
 * Returns { command, args, stdinMode } based on provider type.
 *
 * `settingsEnv` is the `~/.claude/settings.json` env block (from
 * `getClaudeSettingsEnv()`). It MUST be folded into the Bedrock-mapping env
 * because that is how a Bedrock host commonly supplies `CLAUDE_CODE_USE_BEDROCK`
 * to the spawned child (see the spawn env below at the `claudeSettingsEnv`
 * merge) — without it, a settings-only Bedrock box would map against an env
 * missing the flag and still emit a bare, Bedrock-invalid `--model`.
 *
 * Per-vendor argv construction is dispatched through the PROVIDER_VENDORS
 * registry (#3618) — see providerVendors.js for each vendor's `spawnArgs` row
 * and the file header on the (preserved, not silently "fixed") asymmetries vs
 * `buildCliArgs` (e.g. codex never forwards `provider.args` here, and there is
 * no gemini-cli row so a legacy gemini-cli provider falls through to claude's
 * default, exactly as before this registry existed).
 */
export function buildCliSpawnConfig(provider, model, settingsEnv = {}, { systemPromptFile = null, effort = null } = {}) {
  // Configured-default sentinels (Codex / Antigravity / Grok Build) → null so
  // the CLI uses its own default without a --model flag.
  const effectiveModel = resolveCliModel(model);
  return buildVendorSpawnConfig(provider, { effectiveModel, effort, systemPromptFile, settingsEnv });
}

/**
 * Check if a provider is a Claude CLI provider that needs settings.json env injection.
 */
export const isClaudeCliProvider = (provider) =>
  provider?.type === PROVIDER_TYPES.CLI && (provider.id === 'claude-code' || provider.id === 'claude-code-bedrock');

/**
 * Check if a provider is a TUI-backed agent provider (Claude Code, Codex,
 * Antigravity, etc. that run in a PTY). Used by callers that need to branch
 * between headless CLI/API runs and TUI shell sessions.
 */
export const isTuiProvider = (provider) => provider?.type === PROVIDER_TYPES.TUI;

/**
 * Read env vars from ~/.claude/settings.json to inject into Claude CLI spawns.
 * Ensures user's Bedrock/provider config (CLAUDE_CODE_USE_BEDROCK, AWS_PROFILE, etc.)
 * is present in spawned agent environments even if PM2 was started without them.
 */
let _claudeSettingsEnvCache = null;
let _claudeSettingsEnvCacheTime = 0;
const SETTINGS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function getClaudeSettingsEnv() {
  if (_claudeSettingsEnvCache !== null && (Date.now() - _claudeSettingsEnvCacheTime) < SETTINGS_CACHE_TTL_MS) return _claudeSettingsEnvCache;
  try {
    const settingsPath = join(homedir(), '.claude', 'settings.json');
    if (existsSync(settingsPath)) {
      const raw = await readFile(settingsPath, 'utf-8');
      const settings = JSON.parse(raw);
      _claudeSettingsEnvCache = settings.env || {};
    } else {
      _claudeSettingsEnvCache = {};
    }
  } catch (err) {
    console.warn(`⚠️ Failed to read claude settings: ${err.message}`);
    _claudeSettingsEnvCache = {};
  }
  _claudeSettingsEnvCacheTime = Date.now();
  return _claudeSettingsEnvCache;
}

/**
 * Spawn agent directly (fallback when runner not available).
 * `cleanupWorktreeFn` and `isTruthyMetaFn` are passed in rather than
 * imported directly. The agentLifecycle.js ↔ agentCliSpawning.js import
 * graph is bidirectional (agentLifecycle calls `spawnDirectly`, this file
 * calls `finalizeAgent`) and ES module hoisting handles it for top-level
 * function references — but importing `cleanupAgentWorktree` /
 * `isTruthyMeta` at module top level would force their `agentLifecycle`
 * and `subAgentSpawner` modules to initialize before this one, racing
 * the cycle in ways that surfaced as `undefined` reads on cold start.
 * Passing them via the options object defers the lookup to call time.
 */
export async function spawnDirectly({
  agentId,
  task,
  prompt,
  workspacePath,
  model,
  provider,
  runId,
  cliConfig,
  agentDir,
  executionId,
  laneName,
  cleanupWorktreeFn,
  isTruthyMetaFn,
}) {
  const fullCommand = `${cliConfig.command} ${cliConfig.args.join(' ')} <<< "${(task.description || '').substring(0, 100)}..."`;

  const ROOT_DIR = PATHS.root;
  // Ensure workspacePath is valid
  const cwd = workspacePath && typeof workspacePath === 'string' ? workspacePath : ROOT_DIR;

  // Two independent async env lookups, resolved together: Claude's
  // ~/.claude/settings.json Bedrock config (CLAUDE_CODE_USE_BEDROCK, AWS_PROFILE,
  // etc., present even if PM2 lacks them) and the repo-owner-pinned GH_TOKEN
  // (so the agent's own `gh pr create` auths as the right account — see
  // resolveForgeTokenEnv; `{}` when there's no owner match). Skip the token probe
  // entirely when the provider supplies its own GH_TOKEN/GITHUB_TOKEN so its
  // explicit credential wins (gh prefers GH_TOKEN, so injecting one would shadow a
  // provider GITHUB_TOKEN).
  const [claudeSettingsEnv, forgeTokenEnv] = await Promise.all([
    isClaudeCliProvider(provider) ? getClaudeSettingsEnv() : Promise.resolve({}),
    providerSuppliesGithubToken(provider) ? Promise.resolve({}) : resolveForgeTokenEnv(cwd),
  ]);

  // Shared composition (provider.envVars + OpenCode models map + PWD pin +
  // CLAUDECODE strip) — see buildCliChildEnv. forgeTokenEnv/claudeSettingsEnv go
  // in `before` so they sit UNDER provider.envVars and an explicit provider
  // GH_TOKEN override still wins. `guard: true` prepends the pm2 shim onto the
  // final PATH so a `--dangerously-skip-permissions` agent can't `pm2 kill` the
  // shared daemon.
  const childEnv = buildCliChildEnv({
    before: { ...forgeTokenEnv, ...claudeSettingsEnv },
    provider,
    model,
    cwd,
    guard: true,
  });

  // Resolve a bare npm-installed CLI (a .cmd/.bat shim on Windows) to its real
  // path and wrap a shim as `cmd.exe /c <path>` so spawn() under shell:false
  // can launch it — without this Windows can't find e.g. `opencode.cmd` from the
  // bare name → spawn ENOENT (errno -4058) → startup-failure. Mirrors the
  // working "Run Prompt" path (server/services/runner.js); resolved against
  // childEnv so a provider PATH override is honored. See issue #2243.
  // Deliver the prompt per provider convention: antigravity as the --print
  // VALUE and kimi as the --prompt VALUE (no stdin); grok's `--prompt-file
  // /dev/stdin` via stdin (POSIX) / temp file (Windows); every other provider via
  // stdin (writePromptToStdin=true).
  const { args: deliveredArgs, useStdin: writePromptToStdin, cleanup: cleanupPromptFile } = prepareCliPrompt(cliConfig.command, cliConfig.args, prompt);
  const { command: spawnCommand, args: spawnArgs } = prepareCliSpawn(cliConfig.command, deliveredArgs, childEnv);

  const claudeProcess = spawn(spawnCommand, spawnArgs, {
    cwd,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: childEnv
  });

  registerSpawnedAgent(claudeProcess.pid, {
    fullCommand,
    agentId,
    taskId: task.id,
    model,
    workspacePath,
    prompt: (task.description || '').substring(0, 500)
  });

  if (writePromptToStdin) claudeProcess.stdin.write(prompt);
  claudeProcess.stdin.end();

  activeAgents.set(agentId, {
    process: claudeProcess,
    taskId: task.id,
    startedAt: Date.now(),
    runId,
    pid: claudeProcess.pid,
    providerId: provider.id,
    executionId,
    laneName
  });

  // Store PID in persisted state for zombie detection
  await updateAgent(agentId, { pid: claudeProcess.pid });

  let outputBuffer = '';
  let rawStreamBuffer = ''; // Raw stdout for stream-json (used for error analysis)
  let hasStartedWorking = false;
  const outputFile = join(agentDir, 'output.txt');
  const isStreamJson = cliConfig.streamFormat === 'stream-json';
  const streamParser = isStreamJson ? createStreamJsonParser() : null;
  const codexStderrFormatter = provider.id === 'codex' ? createCodexStderrFormatter(prompt) : null;
  let immediateFallbackAnalysis = null;
  const detectImmediateFallbackSignal = createImmediateFallbackSignalDetector();

  // Debounced state-write batcher for streamed output. stdout/stderr `data`
  // events fire per chunk (and stream-json yields many lines per chunk), so a
  // per-line/per-chunk appendAgentOutput would round-trip a full state
  // load+save each time. The batcher coalesces a ~250ms window; the close/error
  // handlers `await outputBatcher.flush()` so the final lines persist before
  // the agent is finalized. (output.txt is written separately below.)
  const outputBatcher = createAgentOutputBatcher(agentId);

  // Expose a drain hook on the activeAgents entry so the user-terminate/kill
  // paths (agentManagement.js) can flush pending batched output before they
  // mark the agent complete — otherwise up to one debounce window of
  // stdout/stderr could land after the terminal record. (The close handler
  // still drains too; flush() is idempotent.)
  const cliAgentEntry = activeAgents.get(agentId);
  // Drain the serialized write chain (defined just below) before flushing the
  // batcher so any enqueued-but-unrun stdout/stderr push lands first.
  if (cliAgentEntry) cliAgentEntry.flushOutput = async () => {
    await drainTranscriptWrites();
    await outputBatcher.flush();
  };

  // Serialize the transcript-mutating body of every stdout/stderr `data` event
  // onto a single per-agent tail promise. Both handlers mutate the same shared
  // `outputBuffer`/`rawStreamBuffer` and write the same `output.txt`, so their
  // interleaved awaits (e.g. one chunk's `writeFile` yielding while the next
  // chunk appends) would otherwise reorder the transcript (#2384). Fallback
  // detection stays OUTSIDE this chain — it runs synchronously in the raw
  // listener before the enqueue, so a blocked earlier write can never delay
  // killing the provider on a usage-limit signal. The close/error handlers
  // `await drainTranscriptWrites()` before finalize so the tail lands first.
  // Mirrors shell.js `hookQueue` and pipeline/issues.js `issueWriteTail`.
  let transcriptWriteTail = Promise.resolve();
  const enqueueTranscriptWrite = (fn) => {
    transcriptWriteTail = transcriptWriteTail.then(fn).catch((err) => {
      // Runs in a child-process callback — a rejection here would escape as an
      // unhandled rejection and crash Node. output.txt is best-effort; log+swallow.
      console.error(`❌ agentCli transcript write failed for ${agentId}: ${err.message}`);
    });
    return transcriptWriteTail;
  };
  const drainTranscriptWrites = () => transcriptWriteTail;

  const stopForImmediateFallbackSignal = (text) => {
    if (immediateFallbackAnalysis || claudeProcess.killed) return;
    const analysis = detectImmediateFallbackSignal(text);
    if (!analysis) return;
    immediateFallbackAnalysis = analysis;
    emitLog('warn', `Agent ${agentId} detected provider fallback signal (${analysis.category}); stopping ${provider.name || provider.id}`, {
      agentId,
      taskId: task.id,
      providerId: provider.id,
      category: analysis.category
    });
    // killProcessTree so a Windows cmd.exe-wrapped shim's real child isn't orphaned (#2243).
    killProcessTree(claudeProcess, 'SIGTERM');
  };

  // If no output after 3 seconds, transition from initializing to working to show progress
  const initializationTimeout = setTimeout(async () => {
    try {
      if (!hasStartedWorking && activeAgents.has(agentId)) {
        hasStartedWorking = true;
        await updateAgent(agentId, { metadata: { phase: 'working' } });
        emitLog('info', `Agent ${agentId} working (after initialization delay)...`, { agentId, phase: 'working' });
      }
    } catch (err) {
      console.error(`❌ agentCliSpawning init timeout failed for ${agentId}: ${err.message}`);
    }
  }, 3000);

  claudeProcess.stdout.on('data', (data) => {
    try {
      const text = data.toString();
      // Detect fallback signals SYNCHRONOUSLY, before enqueuing any transcript
      // mutation — a blocked earlier write must never delay killing the provider
      // on a usage-limit signal (#2384).
      stopForImmediateFallbackSignal(text);
      // Serialize the transcript body so two `data` events can't interleave their
      // awaits and reorder output.txt / the batched live tail.
      enqueueTranscriptWrite(async () => {
        if (!hasStartedWorking) {
          hasStartedWorking = true;
          await updateAgent(agentId, { metadata: { phase: 'working' } });
          emitLog('info', `Agent ${agentId} working...`, { agentId, phase: 'working' });
        }

        if (streamParser) {
          // Parse stream-json and emit extracted text lines (cap buffer at 512KB for error analysis)
          rawStreamBuffer += text;
          if (rawStreamBuffer.length > 512 * 1024) {
            rawStreamBuffer = rawStreamBuffer.slice(-512 * 1024);
          }
          const lines = streamParser.processChunk(text);
          for (const line of lines) outputBuffer += line + '\n';
          outputBatcher.push(lines);
          await writeFile(outputFile, outputBuffer).catch(() => {});
        } else {
          // Non-stream providers: emit raw stdout as before
          outputBuffer += text;
          await writeFile(outputFile, outputBuffer).catch(() => {});
          outputBatcher.push(text);
        }
      });
    } catch (err) {
      console.error(`❌ agentCli stdout handler failed: ${err.message}`);
    }
  });

  claudeProcess.stderr.on('data', (data) => {
    try {
      const text = data.toString();
      // Synchronous fallback detection before the serialized write (see stdout).
      stopForImmediateFallbackSignal(`[stderr] ${text}`);
      enqueueTranscriptWrite(async () => {
        // Codex stderr: show thinking + tool names, skip config dump and command output
        if (codexStderrFormatter) {
          const lines = codexStderrFormatter.processChunk(text);
          for (const line of lines) outputBuffer += line + '\n';
          outputBatcher.push(lines);
          await writeFile(outputFile, outputBuffer).catch(() => {});
          return;
        }
        outputBuffer += `[stderr] ${text}`;
        await writeFile(outputFile, outputBuffer).catch(() => {});
        outputBatcher.push(`[stderr] ${text}`);
      });
    } catch (err) {
      console.error(`❌ agentCli stderr handler failed: ${err.message}`);
    }
  });

  claudeProcess.on('error', async (err) => {
    // Runs outside the request lifecycle — an uncaught throw from the awaited
    // completeAgent/completeAgentRun would crash the process, so wrap the body.
    try {
      clearTimeout(initializationTimeout);
      cleanupPromptFile();
      console.error(`❌ Agent ${agentId} spawn error: ${err.message}`);

      // Release execution lane
      if (laneName) {
        release(agentId);
      }

      // Complete tool execution tracking with error
      if (executionId) {
        errorExecution(executionId, { message: err.message, category: 'spawn-error' });
        completeExecution(executionId, { success: false });
      }

      const agentDataErr = activeAgents.get(agentId);
      if (agentDataErr?.killTimer) {
        clearTimeout(agentDataErr.killTimer);
        agentDataErr.killTimer = null;
      }

      cosEvents.emit('agent:error', { agentId, error: err.message });
      // Drain queued transcript writes before flushing the batcher + recording
      // the run so outputBuffer reflects everything that streamed (#2384).
      await drainTranscriptWrites();
      await outputBatcher.flush();
      await completeAgent(agentId, { success: false, error: err.message });
      await completeAgentRun(runId, outputBuffer, 1, 0, { message: err.message, category: 'spawn-error' });
      unregisterSpawnedAgent(claudeProcess.pid);
      activeAgents.delete(agentId);
    } catch (handlerErr) {
      console.error(`❌ Agent ${agentId} error handler failed: ${handlerErr.message}`);
      activeAgents.delete(agentId);
    }
  });

  claudeProcess.on('close', async (code) => {
    // Runs outside the request lifecycle — a throw from outputBatcher.flush,
    // analyzeAgentFailure, or finalizeAgent would re-escape this async handler
    // as an unhandled rejection and crash the process. The inner try/finally
    // only covers finalizeAgent's cleanup; this outer guard is the crash net.
    // `laneReleased` lets the recovery path free a still-held execution lane
    // (a throw before releaseAgentLane) without double-releasing one that ran.
    let laneReleased = false;
    try {
    clearTimeout(initializationTimeout);
    cleanupPromptFile();
    const success = code === 0;
    const agentData = activeAgents.get(agentId);
    const duration = Date.now() - (agentData?.startedAt || Date.now());

    // If terminateAgent scheduled a SIGKILL fallback, the process exited
    // before it fired — clear it so we don't leak the timer.
    if (agentData?.killTimer) {
      clearTimeout(agentData.killTimer);
      agentData.killTimer = null;
    }

    const terminatedByUser = userTerminatedAgents.has(agentId);
    if (terminatedByUser) userTerminatedAgents.delete(agentId);
    // This run's own sentinel (see doneSentinelName) — a worktree-less agent
    // shares its workspace and must not read a sibling's signal as its own.
    const sentinelPath = doneSentinelPath(workspacePath, agentId);
    const completionSentinelPresent = !!sentinelPath && existsSync(sentinelPath);
    const completedBeforeHostShutdown = isHostShuttingDown() && completionSentinelPresent;

    // If the user terminated the agent, force success=false even if the
    // process happened to exit 0 in the race window — otherwise the run is
    // recorded as successful while the task remains blocked. Mirrors the TUI
    // `finish` path's `finalSuccess = terminatedByUser ? false : success`.
    // A mid-stream fallback signal (e.g. usage-limit hit) kills the CLI; if it
    // races to exit 0, don't record success or the fallback/retry never fires.
    // A completion sentinel written before host shutdown is also authoritative:
    // TreeKill may surface its otherwise-completed child with a null exit code.
    // Mirrors the runner path (`runner.js`) and the TUI finish() handling.
    const finalSuccess = terminatedByUser
      ? false
      : ((success || completedBeforeHostShutdown) && !immediateFallbackAnalysis);
    const finalError = terminatedByUser ? 'Agent terminated by user' : null;

    // Drain any queued transcript writes before reading/appending outputBuffer
    // for finalization — a still-pending stdout/stderr write would otherwise
    // land after the terminal record or clobber the final output.txt (#2384).
    // No new `data` events fire after 'close', so a single drain is sufficient.
    await drainTranscriptWrites();

    // Flush remaining stream parser data (persists the tail of the transcript
    // before any early-return, so a paused agent's output.txt is complete for
    // the resume modal).
    if (streamParser) {
      const remaining = streamParser.flush();
      for (const line of remaining) {
        outputBuffer += line + '\n';
        outputBatcher.push(line);
      }
      // Use the parsed final result for the output file if available
      const finalResult = streamParser.getFinalResult();
      if (finalResult) {
        outputBuffer = finalResult;
      }
    }
    if (codexStderrFormatter) {
      for (const line of codexStderrFormatter.flush()) {
        outputBuffer += line + '\n';
        outputBatcher.push(line);
      }
    }

    // Drain pending output to state before finalize so the transcript tail
    // lands before the agent's terminal record (covers the paused early-return
    // below too, since output.txt is written next).
    await outputBatcher.flush();

    await writeFile(outputFile, outputBuffer).catch(() => {});

    // Paused agents are finalized in `markAgentPaused` (which already released
    // the lane + execution). Return BEFORE `releaseAgentLane` below — re-running
    // it on the same executionId logs a spurious "Invalid state transition".
    // Mirrors the TUI path's pause-check-before-releaseAgentLane ordering.
    if (pausedAgents.has(agentId)) {
      pausedAgents.delete(agentId);
      if (agentData?.pid) unregisterSpawnedAgent(agentData.pid);
      activeAgents.delete(agentId);
      return;
    }

    // PortOS is going down and took this child with it (pm2's TreeKill walks
    // portos-server's descendants). Abandon rather than finalize, for the same
    // reasons as the TUI path (#3202): finalizing would charge the task's
    // failure budget — and possibly file an investigation task — for a fault the
    // agent didn't have, and its cleanup hands the worktree to `cleanupWorktreeFn`,
    // which removes a clean tree, discarding the state a resume needs. Leaving
    // the record `running` is what lets the next boot's orphan sweep see this
    // agent in the host-shutdown marker and requeue it as interrupted.
    // The transcript is already flushed and output.txt written above.
    // A user-terminated run still finalizes, so it's recorded as such rather
    // than resurrected by the requeue.
    if (shouldAbandonForHostShutdown({
      sentinelPresent: completionSentinelPresent,
      terminatedByUser,
      paused: pausedAgents.has(agentId),
    })) {
      outputBatcher.push('🛑 PortOS restarted while this agent was running — the run was interrupted, not completed. Its worktree is preserved and the task will resume.');
      emitLog('warn', `Agent ${agentId} interrupted by a PortOS host restart — preserved for resume`, { agentId, phase: 'interrupted' });
      await Promise.all([
        outputBatcher.flush().catch(() => {}),
        updateAgent(agentId, { metadata: { phase: 'interrupted', interruptedBy: HOST_SHUTDOWN_REASON } })
          .catch(err => emitLog('warn', `Could not mark agent ${agentId} interrupted: ${err.message}`, { agentId })),
      ]);
      // activeAgents entry left in place — the shutdown handler reads that map
      // to name the agents in the host-shutdown marker.
      return;
    }

    // Release lane + complete execution tracking BEFORE the error-analysis +
    // state-write chain — neither call blocks on I/O, but lanes serialize
    // related work. Fall back to outer scope when activeAgents was cleared by
    // killAgent before close fired.
    releaseAgentLane({
      agentId,
      success: finalSuccess,
      duration,
      exitCode: code,
      executionId: agentData?.executionId || executionId,
      laneName: agentData?.laneName || laneName,
      errorExecutionMessage: finalError || undefined,
    });
    laneReleased = true;

    // Use raw stream buffer for error analysis (contains full JSON with error details)
    const analysisBuffer = rawStreamBuffer || outputBuffer;
    const errorAnalysis = finalSuccess ? null : (immediateFallbackAnalysis || analyzeAgentFailure(analysisBuffer, task, model));

    // Every CLI agent that is a real coding harness drives its own push → PR →
    // review → merge (#3733): a slashdo-capable Claude runs `/simplify` +
    // `/do:pr`, codex/grok/agy/OpenCode run the plain `git`/`gh` equivalent from
    // the same prompt (see buildCliCompletionSection in agentPromptBuilder.js).
    // Mirror that here so PortOS doesn't double-fire push+PR creation.
    const directOpenPR = isTruthyMetaFn(task.metadata?.openPR);
    const directLeanMode = isOllamaClaudeProvider(provider);
    const directAgentOwnsPR = directOpenPR && agentOwnsPrWorkflow({
      providerType: PROVIDER_TYPES.CLI,
      leanMode: directLeanMode,
    });
    // PR-claim verification (#3358) stays on the SLASH-command predicate: it runs
    // BEFORE the cleanup below, and cleanup now backstops a harness that skipped
    // its own PR step — failing the run here for a PR that is about to exist
    // would turn a recovered handoff into a false needs-attention.
    const directPrClaimExpected = directOpenPR && canTypeSlashCommands({
      providerId: provider?.id,
      providerCommand: provider?.command,
      leanMode: directLeanMode,
    });
    // Whether finalize's check ACTUALLY produced a forge answer (filled in from
    // its return below) — not the same question as whether one was expected.
    // Finalize substitutes `{ok:true}` for a user-terminated run and for a check
    // that threw, and a throw from finalize skips the assignment entirely; in all
    // three cases nothing was verified, so cleanup must ask rather than stand down.
    let directPrClaimVerified = false;

    // try/finally so a throw from finalizeAgent still runs the local
    // cleanup (worktree, pid unregister, activeAgents delete). Mirrors the
    // TUI path's pattern.
    // See the TUI path: a PR-claim downgrade must reach cleanup, or a run that
    // opened no PR is cleaned up as a success and loses its retry state (#3358).
    let cleanupSuccess = finalSuccess;
    try {
      const finalized = await finalizeAgent({
        agentId,
        task,
        runId: agentData?.runId || runId,
        providerId: agentData?.providerId || provider.id,
        success: finalSuccess,
        exitCode: code,
        duration,
        outputBuffer,
        errorAnalysis,
        terminatedByUser,
        isTruthyMetaFn,
        error: finalError || undefined,
        completionReason: terminatedByUser ? 'user-terminated' : undefined,
        workspacePath,
        prExpected: directPrClaimExpected,
        // The run window the commit criterion is evaluated against (#3637).
        startedAt: agentData?.startedAt ?? null,
      });
      if (finalized && typeof finalized.success === 'boolean') cleanupSuccess = finalized.success;
      directPrClaimVerified = prClaimWasVerified(finalized?.prVerdict);
    } finally {
      const directPrCompletion = resolvePrCompletion(task.metadata);
      const directReviewLoopFollowUp = isTruthyMetaFn(task.metadata?.reviewLoopFollowUp);
      const reviewOptions = await resolveReviewLoopOptions(task.metadata, { normalize: normalizeReviewers, isTruthyMeta: isTruthyMetaFn });
      await cleanupWorktreeFn(agentId, cleanupSuccess, {
        prCreation: resolvePrCreation({
          taskOpenPR: directOpenPR,
          agentOwnsPr: directAgentOwnsPR,
          prClaimVerified: directPrClaimVerified,
        }),
        prCompletion: directPrCompletion,
        ...reviewOptions,
        skipMerge: directReviewLoopFollowUp || directAgentOwnsPR,
        description: task.description,
        agentOutput: outputBuffer,
        originalTask: task
      }).catch(err => console.error(`❌ CLI worktree cleanup failed for ${agentId}: ${err.message}`));

      // Release the retry hold: flip the failed task back to `pending` carrying a
      // pointer at whatever the run left behind — the branch (or whole worktree)
      // `cleanupWorktreeFn` just preserved because the run failed with commits on
      // it. Without the pointer the retry starts clean and redoes work already
      // sitting on disk (#3368); without the hold that release replaces, the retry
      // could be dequeued before the pointer landed (#3373). Imported lazily for the
      // same reason `cleanupWorktreeFn` is injected: pulling the cleanup graph in at
      // module top level races this file's own init in the agentLifecycle cycle.
      await import('./agentWorktreeCleanup.js')
        .then(({ releaseRetryHold }) => releaseRetryHold({ agentId, task, success: cleanupSuccess }))
        .catch(err => console.error(`❌ CLI retry-hold release failed for ${agentId}: ${err.message}`));

      unregisterSpawnedAgent(agentData?.pid || claudeProcess.pid);
      activeAgents.delete(agentId);
    }
    } catch (handlerErr) {
      console.error(`❌ Agent ${agentId} close handler error: ${handlerErr.message}`);
      // A paused agent was already persisted + lane-released by markAgentPaused;
      // if the throw beat the pause guard above, do ONLY the in-memory cleanup
      // (mirrors the normal pause path) — finalizing it as failed here would
      // overwrite the paused state and break later resume.
      if (pausedAgents.has(agentId)) {
        pausedAgents.delete(agentId);
        unregisterSpawnedAgent(claudeProcess.pid);
        activeAgents.delete(agentId);
      } else {
        // If the throw beat releaseAgentLane, the lane/execution is still held.
        // The process now survives instead of restarting, so a held lane would
        // block later tasks indefinitely — release it on the recovery path too.
        if (!laneReleased) {
          try {
            releaseAgentLane({
              agentId,
              success: false,
              exitCode: code,
              executionId,
              laneName,
              errorExecutionMessage: `Agent close handler error: ${handlerErr.message}`,
            });
          } catch (releaseErr) {
            console.error(`❌ Agent ${agentId} lane release failed during recovery: ${releaseErr.message}`);
          }
        }
        // Persist a terminal failure record so the agent/run don't stay stuck as
        // running with no live process to finish them — the process now survives
        // instead of restarting. Mirrors the error handler's completion path;
        // each call is guarded so a persistence failure can't re-crash.
        try {
          await completeAgent(agentId, { success: false, error: `Close handler error: ${handlerErr.message}` });
        } catch (completeErr) {
          console.error(`❌ Agent ${agentId} completeAgent failed during recovery: ${completeErr.message}`);
        }
        try {
          await completeAgentRun(runId, outputBuffer, 1, 0, { message: handlerErr.message, category: 'close-handler-error' });
        } catch (runErr) {
          console.error(`❌ Agent ${agentId} completeAgentRun failed during recovery: ${runErr.message}`);
        }
        unregisterSpawnedAgent(claudeProcess.pid);
        activeAgents.delete(agentId);
      }
    }
  });

  return agentId;
}
