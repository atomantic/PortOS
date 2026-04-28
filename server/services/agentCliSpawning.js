/**
 * Agent CLI Spawning
 *
 * Handles building spawn configurations, stream-json parsing, tool input
 * summarization, and Claude settings env injection for agent processes.
 */

import { join } from 'path';
import { readFile, writeFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { spawn } from 'child_process';
import { homedir } from 'os';
import { cosEvents, emitLog } from './cosEvents.js';
import { updateAgent, completeAgent, appendAgentOutput } from './cosAgents.js';
import { registerSpawnedAgent, unregisterSpawnedAgent } from './agents.js';
import { markProviderUsageLimit, markProviderRateLimited } from './providerStatus.js';
import { updateTask } from './cos.js';
import { release } from './executionLanes.js';
import { completeExecution, errorExecution } from './toolStateMachine.js';
import { analyzeAgentFailure, resolveFailedTaskUpdate } from './agentErrorAnalysis.js';
import { completeAgentRun } from './agentRunTracking.js';
import { processAgentCompletion } from './agentCompletion.js';
import { persistSimplifySummaries } from './agentLifecycle.js';
import { activeAgents, userTerminatedAgents } from './agentState.js';
import { safeJSONParse, PATHS } from '../lib/fileUtils.js';

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
 */
export function buildCliSpawnConfig(provider, model) {
  const providerId = provider?.id || 'claude-code';

  // Codex CLI uses different invocation pattern
  if (providerId === 'codex') {
    const args = ['exec'];
    if (model) {
      args.push('--model', model);
    }
    return {
      command: provider?.command || 'codex',
      args,
      stdinMode: 'prompt' // codex exec reads prompt from stdin
    };
  }

  // Gemini CLI — uses --yolo for auto-approval, -p for non-interactive stdin mode
  if (providerId === 'gemini-cli') {
    const args = ['--yolo', ...(provider?.args || [])];
    if (model) {
      args.push('--model', model);
    }
    return {
      command: provider?.command || 'gemini',
      args,
      stdinMode: 'prompt'
    };
  }

  // Default: Claude Code CLI
  const args = [
    '--dangerously-skip-permissions', // Unrestricted mode
    '--print',                          // Print output and exit
    '--output-format', 'stream-json',   // Stream JSON events for live output
    '--verbose',                        // Required for stream-json
    '--include-partial-messages',       // Include incremental text deltas
    ...(provider?.args || []),          // User-configured provider args
  ];
  if (model) {
    args.push('--model', model);
  }

  return {
    command: provider?.command || process.env.CLAUDE_PATH || 'claude',
    args,
    stdinMode: 'prompt',
    streamFormat: 'stream-json'
  };
}

/**
 * Check if a provider is a Claude CLI provider that needs settings.json env injection.
 */
export const isClaudeCliProvider = (provider) =>
  provider?.type === 'cli' && (provider.id === 'claude-code' || provider.id === 'claude-code-bedrock');

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
 * `cleanupWorktreeFn` is passed in to avoid circular imports with agentLifecycle.js.
 * `isTruthyMetaFn` is passed in to avoid circular imports with subAgentSpawner.js.
 */
export async function spawnDirectly(agentId, task, prompt, workspacePath, model, provider, runId, cliConfig, agentDir, executionId, laneName, { cleanupWorktreeFn, isTruthyMetaFn }) {
  const fullCommand = `${cliConfig.command} ${cliConfig.args.join(' ')} <<< "${(task.description || '').substring(0, 100)}..."`;

  const ROOT_DIR = PATHS.root;
  // Ensure workspacePath is valid
  const cwd = workspacePath && typeof workspacePath === 'string' ? workspacePath : ROOT_DIR;

  // For Claude CLI providers, inject ~/.claude/settings.json env vars so Bedrock config
  // (CLAUDE_CODE_USE_BEDROCK, AWS_PROFILE, etc.) is present even if PM2 lacks them
  const claudeSettingsEnv = isClaudeCliProvider(provider)
    ? await getClaudeSettingsEnv()
    : {};

  const claudeProcess = spawn(cliConfig.command, cliConfig.args, {
    cwd,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: (() => { const e = { ...process.env, ...claudeSettingsEnv, ...provider.envVars }; delete e.CLAUDECODE; return e; })()
  });

  registerSpawnedAgent(claudeProcess.pid, {
    fullCommand,
    agentId,
    taskId: task.id,
    model,
    workspacePath,
    prompt: (task.description || '').substring(0, 500)
  });

  claudeProcess.stdin.write(prompt);
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

  // If no output after 3 seconds, transition from initializing to working to show progress
  const initializationTimeout = setTimeout(async () => {
    if (!hasStartedWorking && activeAgents.has(agentId)) {
      hasStartedWorking = true;
      await updateAgent(agentId, { metadata: { phase: 'working' } });
      emitLog('info', `Agent ${agentId} working (after initialization delay)...`, { agentId, phase: 'working' });
    }
  }, 3000);

  claudeProcess.stdout.on('data', async (data) => {
    const text = data.toString();

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
      for (const line of lines) {
        outputBuffer += line + '\n';
        await appendAgentOutput(agentId, line);
      }
      await writeFile(outputFile, outputBuffer).catch(() => {});
    } else {
      // Non-stream providers: emit raw stdout as before
      outputBuffer += text;
      await writeFile(outputFile, outputBuffer).catch(() => {});
      await appendAgentOutput(agentId, text);
    }
  });

  claudeProcess.stderr.on('data', async (data) => {
    const text = data.toString();
    // Codex stderr: show thinking + tool names, skip config dump and command output
    if (provider.id === 'codex') {
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith('Reading prompt from stdin')) continue;
        if (trimmed.startsWith('OpenAI Codex v')) continue;
        if (trimmed.startsWith('succeeded in')) continue;
        // Tool calls: show just the command, strip output after "succeeded"
        if (trimmed.startsWith('exec ')) {
          const match = trimmed.match(/^exec\s+\S+\s+-lc\s+(['"])(.*?)\1/);
          const cmd = match ? match[2] : trimmed.split(' in /')[0];
          const display = `🔧 ${cmd}`;
          outputBuffer += display + '\n';
          await appendAgentOutput(agentId, display);
          continue;
        }
        // Skip long lines (command output like file contents, directory listings)
        if (trimmed.length > 300) continue;
        outputBuffer += trimmed + '\n';
        await appendAgentOutput(agentId, trimmed);
      }
      await writeFile(outputFile, outputBuffer).catch(() => {});
      return;
    }
    outputBuffer += `[stderr] ${text}`;
    await writeFile(outputFile, outputBuffer).catch(() => {});
    await appendAgentOutput(agentId, `[stderr] ${text}`);
  });

  claudeProcess.on('error', async (err) => {
    clearTimeout(initializationTimeout);
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
    await completeAgent(agentId, { success: false, error: err.message });
    await completeAgentRun(runId, outputBuffer, 1, 0, { message: err.message, category: 'spawn-error' });
    unregisterSpawnedAgent(claudeProcess.pid);
    activeAgents.delete(agentId);
  });

  claudeProcess.on('close', async (code) => {
    clearTimeout(initializationTimeout);
    const success = code === 0;
    const agentData = activeAgents.get(agentId);
    const duration = Date.now() - (agentData?.startedAt || Date.now());

    // If terminateAgent scheduled a SIGKILL fallback, the process exited
    // before it fired — clear it so we don't leak the timer.
    if (agentData?.killTimer) {
      clearTimeout(agentData.killTimer);
      agentData.killTimer = null;
    }

    // Flush remaining stream parser data
    if (streamParser) {
      const remaining = streamParser.flush();
      for (const line of remaining) {
        outputBuffer += line + '\n';
        await appendAgentOutput(agentId, line);
      }
      // Use the parsed final result for the output file if available
      const finalResult = streamParser.getFinalResult();
      if (finalResult) {
        outputBuffer = finalResult;
      }
    }

    // Release execution lane
    if (agentData?.laneName) {
      release(agentId);
    }

    // Complete tool execution tracking
    if (agentData?.executionId) {
      if (success) {
        completeExecution(agentData.executionId, { success: true, duration });
      } else {
        errorExecution(agentData.executionId, { message: `Agent exited with code ${code}`, code });
        completeExecution(agentData.executionId, { success: false });
      }
    }

    await writeFile(outputFile, outputBuffer).catch(() => {});

    // Use raw stream buffer for error analysis (contains full JSON with error details)
    const analysisBuffer = rawStreamBuffer || outputBuffer;
    const errorAnalysis = success ? null : analyzeAgentFailure(analysisBuffer, task, model);

    if (success) {
      await persistSimplifySummaries(agentId, task, outputBuffer, isTruthyMetaFn);
    }

    await completeAgent(agentId, {
      success,
      exitCode: code,
      duration,
      outputLength: outputBuffer.length,
      errorAnalysis
    });

    await completeAgentRun(agentData?.runId || runId, outputBuffer, code, duration, errorAnalysis);

    // Update task status with retry tracking
    // Skip if user-terminated — task already blocked by terminateAgent/killAgent
    if (userTerminatedAgents.has(agentId)) {
      userTerminatedAgents.delete(agentId);
      await updateTask(task.id, {
        status: 'blocked',
        metadata: {
          ...task.metadata,
          blockedReason: 'Terminated by user',
          blockedCategory: 'user-terminated',
          blockedAt: new Date().toISOString()
        }
      }, task.taskType || 'user');
    } else if (success) {
      await updateTask(task.id, { status: 'completed' }, task.taskType || 'user');
    } else {
      const failedUpdate = await resolveFailedTaskUpdate(task, errorAnalysis, agentId);
      await updateTask(task.id, failedUpdate, task.taskType || 'user');

      // Handle provider status updates on failure
      if (errorAnalysis) {
        if (errorAnalysis.category === 'usage-limit' && errorAnalysis.requiresFallback) {
          const providerId = agentData?.providerId || provider.id;
          if (providerId) {
            await markProviderUsageLimit(providerId, errorAnalysis).catch(err => {
              emitLog('warn', `Failed to mark provider unavailable: ${err.message}`, { providerId });
            });
          }
        }
        if (errorAnalysis.category === 'rate-limit') {
          const providerId = agentData?.providerId || provider.id;
          if (providerId) {
            await markProviderRateLimited(providerId).catch(err => {
              emitLog('warn', `Failed to mark provider rate limited: ${err.message}`, { providerId });
            });
          }
        }
      }
    }

    // Process memory extraction and app cooldown
    await processAgentCompletion(agentId, task, success, outputBuffer);

    // Clean up ephemeral BTW.md before worktree removal
    if (workspacePath) {
      await rm(join(workspacePath, 'BTW.md')).catch(() => {});
    }

    // Clean up worktree if agent was using one
    await cleanupWorktreeFn(agentId, success, {
      openPR: isTruthyMetaFn(task.metadata?.openPR),
      description: task.description,
      agentOutput: outputBuffer
    });

    unregisterSpawnedAgent(agentData?.pid || claudeProcess.pid);
    activeAgents.delete(agentId);
  });

  return agentId;
}
