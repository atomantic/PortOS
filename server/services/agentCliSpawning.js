/**
 * Agent CLI Spawning
 *
 * Handles building spawn configurations, stream-json parsing, tool input
 * summarization, and Claude settings env injection for agent processes.
 */

import { join } from 'path';
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { spawn } from 'child_process';
import { homedir } from 'os';
import { cosEvents, emitLog } from './cosEvents.js';
import { updateAgent, completeAgent, createAgentOutputBatcher } from './cosAgents.js';
import { registerSpawnedAgent, unregisterSpawnedAgent } from './agents.js';
import { release } from './executionLanes.js';
import { completeExecution, errorExecution } from './toolStateMachine.js';
import { analyzeAgentFailure } from './agentErrorAnalysis.js';
import { completeAgentRun } from './agentRunTracking.js';
import { finalizeAgent, releaseAgentLane } from './agentLifecycle.js';
import { activeAgents, userTerminatedAgents, pausedAgents } from './agentState.js';
import { normalizeReviewers } from '../lib/validation.js';
import { resolveReviewLoopOptions } from './codeReview.js';
import { safeJSONParse, PATHS } from '../lib/fileUtils.js';
import { createCodexStderrFormatter } from '../lib/codexCliOutput.js';
import { PROVIDER_TYPES } from '../lib/aiToolkit/constants.js';
import { createImmediateFallbackSignalDetector } from '../lib/aiToolkit/errorDetection.js';
import { ensureAntigravityPrintArgs, isAntigravityCliProvider } from '../lib/antigravity.js';
import { isGrokCommand, ensureGrokHeadlessArgs, prepareGrokPromptFile } from '../lib/grok.js';
import { resolveCliModel, buildEffortArgs, buildCodexStartupArgs, resolveBedrockCliModel, prefixOpencodeModel, hasModelFlag, isOpencodeCommand, applyLeanClaudeArgs, providerSuppliesGithubToken } from '../lib/providerModels.js';
import { agentGuardEnv } from '../lib/agentGuard/index.js';
import { resolveForgeTokenEnv } from './git.js';
import { buildOpencodeEnvVars } from '../lib/opencodeConfig.js';
import { prepareCliSpawn, killProcessTree } from '../lib/bufferedSpawn.js';

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
 */
export function buildCliSpawnConfig(provider, model, settingsEnv = {}, { systemPromptFile = null, effort = null } = {}) {
  const providerId = provider?.id || 'claude-code';
  // Configured-default sentinels (Codex / Antigravity / Grok Build) → null so
  // the CLI uses its own default without a --model flag.
  const effectiveModel = resolveCliModel(model);

  // Codex CLI uses different invocation pattern.
  // `--dangerously-bypass-approvals-and-sandbox` is the Codex equivalent of
  // Claude/Antigravity's `--dangerously-skip-permissions`: it skips all
  // approval prompts AND disables the sandbox. Without it, `codex exec` runs
  // under the default workspace-write sandbox (network blocked, so `gh pr create`
  // can't resolve api.github.com) and, in non-interactive `exec` mode, any
  // command that needs approval is silently cancelled — which is exactly how a
  // codex agent could push a branch over SSH yet fail to open the PR over HTTPS.
  // PortOS runs on a private, single-user, trusted machine (the "externally
  // sandboxed" context this flag documents), matching how we already spawn the
  // other CLIs unrestricted.
  if (providerId === 'codex') {
    // buildCodexStartupArgs disables codex's startup update check so a headless
    // exec run never spends startup time hitting GitHub / kicking off a brew
    // upgrade it can't complete unattended (the fatal interactive-modal variant
    // is documented on buildCodexStartupArgs in providerModels.js).
    const args = ['exec', '--dangerously-bypass-approvals-and-sandbox', ...buildCodexStartupArgs()];
    if (effectiveModel) {
      args.push('--model', effectiveModel);
    }
    args.push(...buildEffortArgs(effort, provider, args));
    return {
      command: provider?.command || 'codex',
      args,
      stdinMode: 'prompt' // codex exec reads prompt from stdin
    };
  }

  // Antigravity CLI (`agy`) replaces Gemini CLI. Use print mode for a
  // headless agent run and keep prompt delivery on stdin.
  if (isAntigravityCliProvider(provider)) {
    const args = ensureAntigravityPrintArgs(provider?.args || []);
    return {
      command: provider?.command || 'agy',
      args,
      stdinMode: 'prompt'
    };
  }

  // OpenCode CLI (`opencode run`): headless agent invocation for a local Ollama
  // model. `opencode run` reads the prompt from stdin and auto-approves tools via
  // the `permission: "allow"` baked into OPENCODE_CONFIG_CONTENT (the equivalent
  // of claude's `--dangerously-skip-permissions` / codex's bypass — appropriate
  // for PortOS's single-user trusted box). The model is namespaced `ollama/<id>`
  // (prefixOpencodeModel). OpenCode emits plain text (no stream-json), so the
  // live-output handler falls through to its default text path.
  if (isOpencodeCommand(provider?.command)) {
    const baseArgs = provider?.args?.includes('run') ? [...provider.args] : ['run', ...(provider?.args || [])];
    const model = prefixOpencodeModel(provider, effectiveModel);
    // Respect a user-baked -m/--model pin (mirrors buildCliArgs) rather than
    // duplicating the flag — opencode takes the last, silently overriding it.
    if (model && !hasModelFlag(baseArgs)) {
      baseArgs.push('-m', model);
    }
    return {
      command: provider.command,
      args: baseArgs,
      stdinMode: 'prompt'
    };
  }

  // Grok Build CLI (`grok`): headless one-shot agent. Reads the combined
  // contract+task prompt from `--prompt-file /dev/stdin` (rewritten to a temp
  // file on Windows at the spawn site — prepareGrokPromptFile), bypasses approval
  // prompts, and emits plain text (the live-output handler falls through to its
  // default text path, like OpenCode). grok is a non-Claude command, so
  // agentLifecycle keeps the operating contract in the stdin prompt (no
  // system-prompt-file split) — matching codex/antigravity/opencode.
  if (isGrokCommand(provider?.command)) {
    return {
      command: provider?.command || 'grok',
      args: ensureGrokHeadlessArgs(provider?.args || [], effectiveModel),
      stdinMode: 'prompt',
    };
  }

  // Default: Claude Code CLI. applyLeanClaudeArgs adds `--bare
  // --strict-mcp-config` for Ollama-backed claude sessions (no-op otherwise,
  // idempotent against user-baked flags); the system-prompt contract file
  // rides via --append-system-prompt-file.
  const args = applyLeanClaudeArgs(provider, [
    '--dangerously-skip-permissions', // Unrestricted mode
    '--print',                          // Print output and exit
    '--output-format', 'stream-json',   // Stream JSON events for live output
    '--verbose',                        // Required for stream-json
    '--include-partial-messages',       // Include incremental text deltas
    ...(provider?.args || []),          // User-configured provider args
  ], provider?.command || 'claude');
  if (systemPromptFile) {
    args.push('--append-system-prompt-file', systemPromptFile);
  }
  if (effectiveModel) {
    // Bedrock box: map a bare Claude id to its region-prefixed Bedrock form
    // just-in-time (no-op off Bedrock / for already-prefixed or non-Claude ids).
    // Env precedence mirrors the actual spawn env below: process.env <
    // settingsEnv (~/.claude/settings.json) < provider.envVars.
    const injectedModel = resolveBedrockCliModel(effectiveModel, {
      env: { ...process.env, ...settingsEnv, ...provider?.envVars },
      providerId,
    });
    args.push('--model', injectedModel);
  }
  // Per-task reasoning-effort override; a user-baked --effort in provider args
  // wins (buildEffortArgs mirrors the hasModelFlag rule). Keyed on the RESOLVED
  // launch command — not the raw provider — so a blank-command claude provider
  // still qualifies, matching the TUI builder's re-keying.
  const command = provider?.command || process.env.CLAUDE_PATH || 'claude';
  args.push(...buildEffortArgs(effort, { id: providerId, command }, args));

  return {
    command,
    args,
    stdinMode: 'prompt',
    streamFormat: 'stream-json'
  };
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

  // For OpenCode Ollama providers, build dynamic OPENCODE_CONFIG_CONTENT with
  // the models map so --model is accepted (the static env var lacked this).
  const opencodeEnv = buildOpencodeEnvVars(provider, model);

  // The pm2 shim must be prepended onto the FINAL PATH (after any
  // provider.envVars override) so a `--dangerously-skip-permissions` agent
  // can't `pm2 kill` the shared daemon. opencodeEnv comes LAST to override
  // the static OPENCODE_CONFIG_CONTENT in provider.envVars; forgeTokenEnv sits
  // before provider.envVars so an explicit provider GH_TOKEN override still wins.
  const childEnv = (() => { const e = { ...process.env, ...forgeTokenEnv, ...claudeSettingsEnv, ...provider.envVars, ...opencodeEnv }; delete e.CLAUDECODE; Object.assign(e, agentGuardEnv(e)); return e; })();

  // Resolve a bare npm-installed CLI (a .cmd/.bat shim on Windows) to its real
  // path and wrap a shim as `cmd.exe /c <path>` so spawn() under shell:false
  // can launch it — without this Windows can't find e.g. `opencode.cmd` from the
  // bare name → spawn ENOENT (errno -4058) → startup-failure. Mirrors the
  // working "Run Prompt" path (server/services/runner.js); resolved against
  // childEnv so a provider PATH override is honored. See issue #2243.
  // Grok's `--prompt-file /dev/stdin` is fed via stdin on POSIX; on Windows it's
  // rewritten to a temp file (useStdin=false). No-op for every other provider.
  const { args: deliveredArgs, useStdin: writePromptToStdin, cleanup: cleanupPromptFile } = prepareGrokPromptFile(cliConfig.args, prompt);
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

    // If the user terminated the agent, force success=false even if the
    // process happened to exit 0 in the race window — otherwise the run is
    // recorded as successful while the task remains blocked. Mirrors the TUI
    // `finish` path's `finalSuccess = terminatedByUser ? false : success`.
    // A mid-stream fallback signal (e.g. usage-limit hit) kills the CLI; if it
    // races to exit 0, don't record success or the fallback/retry never fires.
    // Mirrors the runner path (`runner.js`) and the TUI finish() handling.
    const finalSuccess = terminatedByUser ? false : (success && !immediateFallbackAnalysis);
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

    // try/finally so a throw from finalizeAgent still runs the local
    // cleanup (worktree, pid unregister, activeAgents delete). Mirrors the
    // TUI path's pattern.
    try {
      await finalizeAgent({
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
      });
    } finally {
      // Clean up worktree if agent was using one. Claude Code CLI agents run
      // `/simplify` + `/do:pr` themselves (see buildCliCompletionSection in
      // agentPromptBuilder.js) — mirror the TUI cleanup contract so PortOS
      // doesn't double-fire push+PR creation.
      const directOpenPR = isTruthyMetaFn(task.metadata?.openPR);
      const directReviewLoopFollowUp = isTruthyMetaFn(task.metadata?.reviewLoopFollowUp);
      const directAgentOwnsPR = directOpenPR && (provider?.id === 'claude-code' || provider?.id === 'claude-code-bedrock');
      const reviewOptions = await resolveReviewLoopOptions(task.metadata, { normalize: normalizeReviewers, isTruthyMeta: isTruthyMetaFn });
      await cleanupWorktreeFn(agentId, finalSuccess, {
        openPR: directAgentOwnsPR ? false : directOpenPR,
        requestCopilotReview: !directAgentOwnsPR && directOpenPR && isTruthyMetaFn(task.metadata?.reviewLoop),
        ...reviewOptions,
        skipMerge: directReviewLoopFollowUp || directAgentOwnsPR,
        description: task.description,
        agentOutput: outputBuffer,
        originalTask: task
      }).catch(err => console.error(`❌ CLI worktree cleanup failed for ${agentId}: ${err.message}`));

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
