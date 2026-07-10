import { spawn } from 'child_process';
import { readFile, writeFile, mkdir, access } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
// Dependency-light shared module (node builtins + pure arg builder only), so
// importing it from this standalone process doesn't pull in the AI toolkit.
// Lets the autofixer honor the user's configured CLI provider/model instead
// of hardcoding `claude -p`.
import { pickCliProvider, runCliProviderPrompt } from '../server/lib/cliProviderRun.js';
import { agentGuardEnv } from '../server/lib/agentGuard/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Prepend the guarded pm2 shim to this process's PATH. The fix agent spawned by
// runCliProviderPrompt inherits process.env, so a confused agent told to "restart
// PM2" can't `pm2 kill` the shared daemon (which would down every app + PortOS).
// Our own execPm2 calls use an absolute PM2_BIN, so they bypass the shim.
Object.assign(process.env, agentGuardEnv());

// Resolve PM2 binary to avoid pm2.cmd on Windows (creates visible CMD windows)
const require = createRequire(import.meta.url);
const PM2_BIN = join(dirname(require.resolve('pm2/package.json')), 'bin', 'pm2');

/** Execute a PM2 CLI command via node (bypasses pm2.cmd) */
function execPm2(pm2Args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PM2_BIN, ...pm2Args], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr || `pm2 exited with code ${code}`));
      resolve({ stdout, stderr });
    });
    child.on('error', reject);
  });
}

// Paths
const DATA_DIR = join(__dirname, '../data');
const APPS_FILE = join(DATA_DIR, 'apps.json');
const PROVIDERS_FILE = join(DATA_DIR, 'providers.json');
const SETTINGS_FILE = join(DATA_DIR, 'settings.json');
const AUTOFIXER_DIR = join(DATA_DIR, 'autofixer');
const SESSIONS_DIR = join(AUTOFIXER_DIR, 'sessions');
const INDEX_FILE = join(AUTOFIXER_DIR, 'index.json');

// Track fixed processes to avoid repeated fixes
const recentlyFixed = new Map();
const FIX_COOLDOWN = 30 * 60 * 1000; // 30 minutes
const CHECK_INTERVAL = 15 * 60 * 1000; // 15 minutes
let checkTimer = null;
let shuttingDown = false;

// Load apps from PortOS
async function loadApps() {
  const data = await readFile(APPS_FILE, 'utf8').catch(() => '{"apps":{}}');
  const parsed = JSON.parse(data);
  return Object.entries(parsed.apps || {}).map(([id, app]) => ({ id, ...app }));
}

// Parse JSON, returning `fallback` on read OR parse failure. A corrupt config
// file (partial write, hand-edit) must not throw inside fixProcess — this runs
// in the autofixer's interval loop, outside any request lifecycle, where an
// uncaught throw would take the process down.
async function readJsonSafe(file, fallback) {
  const data = await readFile(file, 'utf8').catch(() => null);
  if (data == null) return fallback;
  try {
    return JSON.parse(data);
  } catch (err) {
    console.error(`❌ [Autofixer] Corrupt JSON in ${file}: ${err.message}`);
    return fallback;
  }
}

// Load PortOS's AI provider registry (shared data file) so the autofixer runs
// through whichever CLI provider the user configured rather than hardcoding
// claude. Returns the on-disk provider map keyed by id.
async function loadProviders() {
  const parsed = await readJsonSafe(PROVIDERS_FILE, { providers: {} });
  return parsed.providers || {};
}

// Load PortOS settings — `settings.autofixer = { providerId, model }` selects
// which CLI provider/model fixes crashed processes.
async function loadSettings() {
  return readJsonSafe(SETTINGS_FILE, {});
}

// Get all monitored process names from registered apps
async function getMonitoredProcesses() {
  const apps = await loadApps();
  const processes = new Set();

  for (const app of apps) {
    for (const procName of app.pm2ProcessNames || []) {
      processes.add(procName);
    }
  }

  return Array.from(processes);
}

// Find app by process name
async function findAppByProcess(processName) {
  const apps = await loadApps();
  return apps.find(app =>
    (app.pm2ProcessNames || []).includes(processName)
  );
}

// History management
async function ensureHistoryDir() {
  await mkdir(SESSIONS_DIR, { recursive: true });
  await access(INDEX_FILE).catch(async () => {
    await writeFile(INDEX_FILE, JSON.stringify([], null, 2));
  });
}

async function loadIndex() {
  const data = await readFile(INDEX_FILE, 'utf8').catch(() => '[]');
  return JSON.parse(data);
}

async function saveIndex(index) {
  await writeFile(INDEX_FILE, JSON.stringify(index, null, 2));
}

async function saveSession(sessionId, prompt, output, metadata) {
  const sessionDir = join(SESSIONS_DIR, sessionId);
  await mkdir(sessionDir, { recursive: true });

  await writeFile(join(sessionDir, 'prompt.txt'), prompt);
  await writeFile(join(sessionDir, 'output.txt'), output);
  await writeFile(join(sessionDir, 'metadata.json'), JSON.stringify(metadata, null, 2));

  const index = await loadIndex();
  const indexEntry = {
    sessionId: metadata.sessionId,
    startTime: metadata.startTime,
    endTime: metadata.endTime,
    duration: metadata.duration,
    success: metadata.success,
    processName: metadata.processName,
    appName: metadata.appName,
    promptPreview: prompt.substring(0, 200),
    outputSize: output.length
  };

  index.unshift(indexEntry);
  if (index.length > 100) {
    index.splice(100);
  }

  await saveIndex(index);
}

// Get PM2 process list
async function getProcessList() {
  const { stdout } = await execPm2(['jlist']);
  const stripped = stdout.replace(/\x1b\[[0-9;]*m/g, '');
  const jsonStart = stripped.indexOf('[{');
  const jsonEnd = stripped.lastIndexOf('}]');

  if (jsonStart < 0 || jsonEnd < 0) {
    console.error(`❌ [Autofixer] Invalid pm2 jlist output`);
    return [];
  }

  return JSON.parse(stripped.substring(jsonStart, jsonEnd + 2));
}

// Get error logs for a process
async function getProcessLogs(processName) {
  const { stdout: errLogs } = await execPm2(['logs', processName, '--lines', '100', '--nostream', '--err']).catch(() => ({ stdout: '' }));
  const { stdout: outLogs } = await execPm2(['logs', processName, '--lines', '50', '--nostream', '--out']).catch(() => ({ stdout: '' }));
  return { errLogs, outLogs };
}

// Cooldown management
function isOnCooldown(processName) {
  const lastFix = recentlyFixed.get(processName);
  if (!lastFix) return false;
  return (Date.now() - lastFix) < FIX_COOLDOWN;
}

function markAsFixed(processName) {
  recentlyFixed.set(processName, Date.now());
}

// Execute Claude CLI to fix the issue
async function fixProcess(processName, app, errorLogs, outputLogs) {
  const sessionId = `autofixer_${processName}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const startTime = new Date().toISOString();

  console.log(`🔧 [Autofixer] Starting fix for ${processName}: ${sessionId}`);

  const prompt = `You are an autonomous autofixer for PortOS. A PM2-managed process has crashed and needs to be fixed.

**CRITICAL INSTRUCTIONS:**
1. Analyze the error logs below to understand what caused the crash
2. Read relevant source files to understand the issue
3. Fix the bug by editing the necessary files
4. After fixing, restart ONLY this process: pm2 restart ${processName}
5. Verify the process starts successfully by checking pm2 list
6. If it still fails, analyze the new error and try again (max 2 attempts)

**🛑 PM2 SAFETY — this is a SHARED server running many apps:**
- ONLY ever run \`pm2 restart ${processName}\` (or \`pm2 logs ${processName}\`). NEVER target a different process.
- NEVER run \`pm2 kill\`, \`pm2 stop\`, \`pm2 delete\`, \`pm2 startup\`/\`unstartup\`, or any \`... all\` form. They take down EVERY app on this machine, including PortOS itself, and are blocked — they will fail.

**App Information:**
- App Name: ${app.name}
- Process Name: ${processName}
- Status: crashed/errored
- Working Directory: ${app.repoPath}

**Error Logs (last 100 lines):**
\`\`\`
${errorLogs || '(no error logs available)'}
\`\`\`

**Output Logs (last 50 lines):**
\`\`\`
${outputLogs || '(no output logs available)'}
\`\`\`

**Your Task:**
Fix the issue and restart the process. Be systematic and thorough. Use the Bash tool to run \`pm2 restart ${processName}\` after making your fixes — never a broader pm2 command.`;

  await ensureHistoryDir();

  const outputBuffer = [];

  // Resolve the configured CLI provider/model (settings.autofixer), falling
  // back to claude-code — the historical default — when unset. The autofixer
  // edits files and runs pm2, so it needs an agentic CLI provider; pickCliProvider
  // restricts to type 'cli' (API chat providers can't do file edits).
  const providers = await loadProviders();
  const settings = await loadSettings();
  const picked = pickCliProvider(providers, settings.autofixer || {});

  // Single completion path — write the session record + return the result.
  const finalize = async ({ success, exitCode, error }) => {
    const endTime = new Date().toISOString();
    const duration = new Date(endTime).getTime() - new Date(startTime).getTime();
    const output = outputBuffer.join('') + (error ? `\n[ERROR] ${error}` : '');

    console.log(`${success ? '✅ [Autofixer] Fix successful' : '❌ [Autofixer] Fix failed'} for ${processName} (exit code: ${exitCode})`);

    const metadata = {
      sessionId,
      startTime,
      endTime,
      duration,
      exitCode,
      success,
      processName,
      appName: app.name,
      appId: app.id,
      repoPath: app.repoPath,
      type: 'autofixer',
      provider: picked.provider?.id || null,
      model: picked.model || null,
      ...(error ? { error } : {}),
    };

    await saveSession(sessionId, prompt, output, metadata);
    console.log(`💾 [Autofixer] Saved session: ${sessionId}`);

    if (success) markAsFixed(processName);
    return { success, sessionId, output, ...(error ? { error } : {}) };
  };

  if (picked.error) {
    outputBuffer.push(`[ERROR] ${picked.error}`);
    console.error(`❌ [Autofixer] ${picked.error}`);
    return finalize({ success: false, exitCode: -1, error: picked.error });
  }

  console.log(`🤖 [Autofixer] Fixing ${processName} via ${picked.provider.id}${picked.model ? ` (${picked.model})` : ''}`);

  const result = await runCliProviderPrompt({
    provider: picked.provider,
    model: picked.model,
    prompt,
    cwd: app.repoPath,
    timeoutMs: 600000, // 10 min — a fix may need several read/edit/restart cycles
    onData: (chunk, stream) => {
      if (stream === 'stderr') {
        outputBuffer.push(`[STDERR] ${chunk}`);
        process.stderr.write(chunk);
      } else {
        outputBuffer.push(chunk);
        process.stdout.write(chunk);
      }
    },
  });

  if (result.error) {
    console.error(`❌ [Autofixer] Error fixing ${processName}: ${result.error}`);
    return finalize({ success: false, exitCode: result.exitCode ?? -1, error: result.error });
  }
  return finalize({ success: result.exitCode === 0, exitCode: result.exitCode });
}

// Main check function
async function checkAndFixProcesses() {
  console.log(`🔍 [Autofixer] Checking PM2 processes...`);

  const monitoredProcesses = await getMonitoredProcesses();

  if (monitoredProcesses.length === 0) {
    console.log(`⚠️ [Autofixer] No apps registered in PortOS`);
    return;
  }

  console.log(`📋 [Autofixer] Monitoring ${monitoredProcesses.length} process(es): ${monitoredProcesses.join(', ')}`);

  const pm2List = await getProcessList();

  if (pm2List.length === 0) {
    console.log(`⚠️ [Autofixer] No PM2 processes found`);
    return;
  }

  const crashedProcesses = pm2List.filter(proc => {
    const status = proc.pm2_env?.status;
    return status === 'errored' && monitoredProcesses.includes(proc.name);
  });

  if (crashedProcesses.length === 0) {
    console.log(`✅ [Autofixer] All monitored processes healthy`);
    return;
  }

  console.log(`🚨 [Autofixer] Found ${crashedProcesses.length} crashed process(es)`);

  for (const proc of crashedProcesses) {
    const processName = proc.name;

    if (isOnCooldown(processName)) {
      console.log(`⏳ [Autofixer] ${processName} is on cooldown, skipping`);
      continue;
    }

    const app = await findAppByProcess(processName);
    if (!app) {
      console.log(`⚠️ [Autofixer] No app found for process ${processName}, skipping`);
      continue;
    }

    console.log(`🔧 [Autofixer] Attempting to fix ${processName} (${app.name})...`);

    const { errLogs, outLogs } = await getProcessLogs(processName);
    await fixProcess(processName, app, errLogs, outLogs);
  }
}

function scheduleNextCheck() {
  if (shuttingDown) return;

  checkTimer = setTimeout(() => {
    checkTimer = null;
    void runCheckCycle();
  }, CHECK_INTERVAL);
}

// Schedule from completion rather than wall-clock time so a long-running fix
// cannot overlap the next process scan. Errors are contained here because this
// loop runs outside a request lifecycle and must keep retrying autonomously.
async function runCheckCycle() {
  try {
    await checkAndFixProcesses();
  } catch (error) {
    console.error(`❌ [Autofixer] Process check failed: ${error?.message || String(error)}`);
  } finally {
    scheduleNextCheck();
  }
}

// Main loop
async function main() {
  console.log(`🚀 [Autofixer] Starting PortOS Autofixer daemon`);
  console.log(`⏱️ [Autofixer] Check interval: ${CHECK_INTERVAL / 60000} minutes`);
  console.log(`⏳ [Autofixer] Fix cooldown: ${FIX_COOLDOWN / 60000} minutes per process`);

  await ensureHistoryDir();

  // Run immediately, then wait a full interval after each pass completes.
  await runCheckCycle();
}

// Graceful shutdown
function shutdown() {
  shuttingDown = true;
  if (checkTimer) {
    clearTimeout(checkTimer);
    checkTimer = null;
  }

  console.log(`\n🛑 [Autofixer] Shutting down...`);
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start
main().catch(error => {
  console.error('💥 [Autofixer] Fatal error:', error?.message || String(error), error?.stack);
  process.exit(1);
});
