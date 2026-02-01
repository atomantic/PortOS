/**
 * Script Runner Service
 *
 * Manages scheduled scripts that can trigger LLM agents
 * when they detect issues requiring investigation.
 */

import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFile, readFile, mkdir, readdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import Cron from 'croner';
import { cosEvents } from './cosEvents.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPTS_DIR = join(__dirname, '../../data/cos/scripts');
const SCRIPTS_STATE_FILE = join(__dirname, '../../data/cos/scripts-state.json');

// Active scheduled jobs
const scheduledJobs = new Map();

// Execution lock to prevent duplicate runs (tracks last execution time)
const executionLock = new Map();

// Allowlist of safe commands for scripts (mirrors commands.js allowlist)
const ALLOWED_SCRIPT_COMMANDS = new Set([
  'npm', 'npx', 'pnpm', 'yarn', 'bun',
  'node', 'deno',
  'git', 'gh',
  'pm2',
  'ls', 'cat', 'head', 'tail', 'grep', 'find', 'wc',
  'pwd', 'which', 'echo', 'env',
  'curl', 'wget',
  'docker', 'docker-compose',
  'make', 'cargo', 'go', 'python', 'python3', 'pip', 'pip3',
  'brew'
]);

// Shell metacharacters that could be used for command injection
// Security: Reject any command containing these to prevent injection via pipes, chaining, etc.
const DANGEROUS_SHELL_CHARS = /[;|&`$(){}[\]<>\\!#*?~]/;

/**
 * Validate a script command against the allowlist
 * Returns { valid: boolean, error?: string, baseCommand?: string, args?: string[] }
 *
 * Security measures:
 * 1. Base command must be in allowlist
 * 2. Command cannot contain shell metacharacters that enable injection
 */
function validateScriptCommand(command) {
  if (!command || typeof command !== 'string') {
    return { valid: false, error: 'Command is required' };
  }

  const trimmed = command.trim();
  if (!trimmed) {
    return { valid: false, error: 'Command cannot be empty' };
  }

  // Security: Check for dangerous shell metacharacters that could enable command injection
  // This prevents attacks like: npm; rm -rf / or npm && malicious_cmd or npm | cat /etc/passwd
  if (DANGEROUS_SHELL_CHARS.test(trimmed)) {
    return {
      valid: false,
      error: 'Command contains disallowed shell characters (security restriction). Pipes, semicolons, and other shell operators are not allowed.'
    };
  }

  // Extract the base command (first word before space)
  const parts = trimmed.split(/\s+/);
  const baseCommand = parts[0];

  if (!ALLOWED_SCRIPT_COMMANDS.has(baseCommand)) {
    return {
      valid: false,
      error: `Command '${baseCommand}' is not in the allowlist. Allowed: ${Array.from(ALLOWED_SCRIPT_COMMANDS).sort().join(', ')}`
    };
  }

  return { valid: true, baseCommand, args: parts.slice(1) };
}

// Schedule presets to cron expressions
const SCHEDULE_PRESETS = {
  'every-5-min': '*/5 * * * *',
  'every-15-min': '*/15 * * * *',
  'every-30-min': '*/30 * * * *',
  'hourly': '0 * * * *',
  'every-6-hours': '0 */6 * * *',
  'daily': '0 9 * * *',
  'weekly': '0 9 * * 1',
  'on-demand': null
};

/**
 * Initialize the script runner
 */
export async function initScriptRunner() {
  await ensureScriptsDir();
  const scripts = await listScripts();

  // Schedule all enabled scripts
  for (const script of scripts) {
    if (script.enabled && script.schedule !== 'on-demand') {
      scheduleScript(script);
    }
  }

  console.log(`📜 Script runner initialized with ${scripts.length} scripts`);
}

/**
 * Ensure scripts directory exists
 */
async function ensureScriptsDir() {
  if (!existsSync(SCRIPTS_DIR)) {
    await mkdir(SCRIPTS_DIR, { recursive: true });
  }
}

/**
 * Load scripts state
 */
async function loadScriptsState() {
  if (!existsSync(SCRIPTS_STATE_FILE)) {
    return { scripts: {} };
  }
  const content = await readFile(SCRIPTS_STATE_FILE, 'utf-8');
  return JSON.parse(content);
}

/**
 * Save scripts state
 */
async function saveScriptsState(state) {
  await writeFile(SCRIPTS_STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Convert schedule to cron expression
 */
function scheduleToCron(schedule, customCron = null) {
  if (customCron) return customCron;
  return SCHEDULE_PRESETS[schedule] || null;
}

/**
 * Schedule a script
 */
export function scheduleScript(script) {
  // Stop existing job if any
  unscheduleScript(script.id);

  const cronExpr = scheduleToCron(script.schedule, script.cronExpression);
  if (!cronExpr) return; // on-demand scripts don't get scheduled

  const job = new Cron(cronExpr, async () => {
    await executeScript(script.id);
  });

  scheduledJobs.set(script.id, job);
  console.log(`⏰ Scheduled script ${script.name} (${script.id}) with cron: ${cronExpr}`);
}

/**
 * Unschedule a script
 */
export function unscheduleScript(scriptId) {
  const job = scheduledJobs.get(scriptId);
  if (job) {
    job.stop();
    scheduledJobs.delete(scriptId);
  }
}

/**
 * Create a new script
 */
export async function createScript(data) {
  // Security: Validate command against allowlist before creating
  const validation = validateScriptCommand(data.command);
  if (!validation.valid) {
    throw new Error(`Invalid script command: ${validation.error}`);
  }

  const id = `script-${uuidv4().slice(0, 8)}`;

  const script = {
    id,
    name: data.name,
    description: data.description || '',
    command: data.command,
    schedule: data.schedule || 'on-demand',
    cronExpression: data.cronExpression || null,
    enabled: data.enabled !== false,
    triggerAction: data.triggerAction || 'log-only', // 'spawn-agent' | 'create-task' | 'log-only'
    triggerPrompt: data.triggerPrompt || '',
    triggerPriority: data.triggerPriority || 'MEDIUM',
    createdAt: new Date().toISOString(),
    lastRun: null,
    lastOutput: null,
    lastExitCode: null,
    lastTriggered: null,
    runCount: 0
  };

  const state = await loadScriptsState();
  state.scripts[id] = script;
  await saveScriptsState(state);

  // Schedule if enabled
  if (script.enabled && script.schedule !== 'on-demand') {
    scheduleScript(script);
  }

  cosEvents.emit('script:created', script);
  return script;
}

/**
 * Update a script
 */
export async function updateScript(id, data) {
  // Security: Validate command against allowlist if being updated
  if (data.command !== undefined) {
    const validation = validateScriptCommand(data.command);
    if (!validation.valid) {
      throw new Error(`Invalid script command: ${validation.error}`);
    }
  }

  const state = await loadScriptsState();
  const script = state.scripts[id];

  if (!script) {
    return null;
  }

  // Update fields
  const updatedScript = {
    ...script,
    name: data.name ?? script.name,
    description: data.description ?? script.description,
    command: data.command ?? script.command,
    schedule: data.schedule ?? script.schedule,
    cronExpression: data.cronExpression ?? script.cronExpression,
    enabled: data.enabled ?? script.enabled,
    triggerAction: data.triggerAction ?? script.triggerAction,
    triggerPrompt: data.triggerPrompt ?? script.triggerPrompt,
    triggerPriority: data.triggerPriority ?? script.triggerPriority,
    updatedAt: new Date().toISOString()
  };

  state.scripts[id] = updatedScript;
  await saveScriptsState(state);

  // Reschedule if needed
  if (updatedScript.enabled && updatedScript.schedule !== 'on-demand') {
    scheduleScript(updatedScript);
  } else {
    unscheduleScript(id);
  }

  cosEvents.emit('script:updated', updatedScript);
  return updatedScript;
}

/**
 * Delete a script
 */
export async function deleteScript(id) {
  unscheduleScript(id);

  const state = await loadScriptsState();
  if (!state.scripts[id]) {
    return false;
  }

  delete state.scripts[id];
  await saveScriptsState(state);

  cosEvents.emit('script:deleted', { id });
  return true;
}

/**
 * Get a script by ID
 */
export async function getScript(id) {
  const state = await loadScriptsState();
  return state.scripts[id] || null;
}

/**
 * List all scripts
 */
export async function listScripts() {
  const state = await loadScriptsState();
  return Object.values(state.scripts).sort((a, b) =>
    new Date(b.createdAt) - new Date(a.createdAt)
  );
}

/**
 * Execute a script
 */
export async function executeScript(scriptId) {
  // De-duplication: prevent duplicate execution within 5 seconds
  const now = Date.now();
  const lastExecution = executionLock.get(scriptId);
  if (lastExecution && (now - lastExecution) < 5000) {
    console.log(`⏭️ Skipping duplicate execution of ${scriptId} (last run ${now - lastExecution}ms ago)`);
    return { success: false, error: 'Duplicate execution prevented', skipped: true };
  }
  executionLock.set(scriptId, now);

  const state = await loadScriptsState();
  const script = state.scripts[scriptId];

  if (!script) {
    executionLock.delete(scriptId);
    return { success: false, error: 'Script not found' };
  }

  // Security: Defense in depth - validate command at execution time
  // (in case state file was manually modified)
  const validation = validateScriptCommand(script.command);
  if (!validation.valid) {
    console.error(`❌ Script ${script.name} has invalid command: ${validation.error}`);
    executionLock.delete(scriptId);
    return { success: false, error: `Invalid command: ${validation.error}` };
  }

  console.log(`▶️ Executing script: ${script.name} (${scriptId})`);
  cosEvents.emit('script:started', { scriptId, name: script.name });

  const startTime = Date.now();

  return new Promise((resolve) => {
    // Security: Use spawn with array of args (shell:false) to prevent shell injection
    // The validation function ensures no metacharacters are present
    const child = spawn(validation.baseCommand, validation.args || [], {
      cwd: join(__dirname, '../../'),
      timeout: 60000, // 1 minute timeout
      shell: false
    });

    let output = '';
    let error = '';

    child.stdout.on('data', (data) => {
      output += data.toString();
    });

    child.stderr.on('data', (data) => {
      error += data.toString();
    });

    child.on('close', async (code) => {
      const duration = Date.now() - startTime;
      const fullOutput = output + (error ? `\n[stderr]\n${error}` : '');

      // Update script state
      script.lastRun = new Date().toISOString();
      script.lastOutput = fullOutput.substring(0, 10000); // Limit stored output
      script.lastExitCode = code;
      script.runCount = (script.runCount || 0) + 1;

      state.scripts[scriptId] = script;
      await saveScriptsState(state);

      // Clear execution lock after completion
      executionLock.delete(scriptId);

      console.log(`✅ Script ${script.name} completed with code ${code} in ${duration}ms`);

      // Handle trigger action
      if (script.triggerAction === 'spawn-agent' && script.triggerPrompt) {
        console.log(`🚀 Triggering agent for script ${script.name}`);
        script.lastTriggered = new Date().toISOString();
        state.scripts[scriptId] = script;
        await saveScriptsState(state);

        cosEvents.emit('task:ready', {
          id: `script-${scriptId}-${Date.now()}`,
          priority: script.triggerPriority,
          description: script.triggerPrompt,
          taskType: 'internal',
          metadata: {
            context: `Script Output:\n\`\`\`\n${fullOutput.substring(0, 5000)}\n\`\`\``,
            source: 'script',
            scriptId,
            scriptName: script.name
          }
        });
      }

      cosEvents.emit('script:completed', {
        scriptId,
        name: script.name,
        exitCode: code,
        duration,
        outputLength: fullOutput.length
      });

      resolve({
        success: code === 0,
        exitCode: code,
        output: fullOutput,
        duration
      });
    });

    child.on('error', async (err) => {
      console.error(`❌ Script ${script.name} error: ${err.message}`);

      script.lastRun = new Date().toISOString();
      script.lastOutput = `Error: ${err.message}`;
      script.lastExitCode = -1;
      state.scripts[scriptId] = script;
      await saveScriptsState(state);

      // Clear execution lock on error
      executionLock.delete(scriptId);

      cosEvents.emit('script:error', { scriptId, error: err.message });

      resolve({
        success: false,
        error: err.message
      });
    });
  });
}

/**
 * Get script run history (from state)
 */
export async function getScriptRuns(scriptId, limit = 10) {
  // For now, we only store the last run in state
  // Could be extended to store full history
  const script = await getScript(scriptId);
  if (!script) return [];

  if (script.lastRun) {
    return [{
      timestamp: script.lastRun,
      output: script.lastOutput,
      exitCode: script.lastExitCode,
      triggered: script.lastTriggered
    }];
  }

  return [];
}

/**
 * Get available schedule presets
 */
export function getSchedulePresets() {
  return Object.keys(SCHEDULE_PRESETS);
}

/**
 * Get scheduled job info
 */
export function getScheduledJobs() {
  const jobs = [];
  for (const [scriptId, job] of scheduledJobs) {
    jobs.push({
      scriptId,
      nextRun: job.nextRun()?.toISOString(),
      isRunning: job.isRunning()
    });
  }
  return jobs;
}

/**
 * Get list of allowed commands for scripts
 */
export function getAllowedScriptCommands() {
  return Array.from(ALLOWED_SCRIPT_COMMANDS).sort();
}
