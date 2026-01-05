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
import { cosEvents } from './cos.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPTS_DIR = join(__dirname, '../../data/cos/scripts');
const SCRIPTS_STATE_FILE = join(__dirname, '../../data/cos/scripts-state.json');

// Active scheduled jobs
const scheduledJobs = new Map();

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
  const state = await loadScriptsState();
  const script = state.scripts[scriptId];

  if (!script) {
    return { success: false, error: 'Script not found' };
  }

  console.log(`▶️ Executing script: ${script.name} (${scriptId})`);
  cosEvents.emit('script:started', { scriptId, name: script.name });

  const startTime = Date.now();

  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', script.command], {
      cwd: join(__dirname, '../../'),
      timeout: 60000 // 1 minute timeout
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
