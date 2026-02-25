import { spawn } from 'child_process';
import { readFile, writeFile, mkdir, access } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import { execFile as execFileCb } from 'child_process';

const IS_WIN = process.platform === 'win32';
const execFileAsync = (cmd, args, opts = {}) => promisify(execFileCb)(cmd, args, { shell: IS_WIN, ...opts });
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Paths
const DATA_DIR = join(__dirname, '../data');
const APPS_FILE = join(DATA_DIR, 'apps.json');
const AUTOFIXER_DIR = join(DATA_DIR, 'autofixer');
const SESSIONS_DIR = join(AUTOFIXER_DIR, 'sessions');
const INDEX_FILE = join(AUTOFIXER_DIR, 'index.json');

// Track fixed processes to avoid repeated fixes
const recentlyFixed = new Map();
const FIX_COOLDOWN = 30 * 60 * 1000; // 30 minutes
const CHECK_INTERVAL = 15 * 60 * 1000; // 15 minutes

// Load apps from PortOS
async function loadApps() {
  const data = await readFile(APPS_FILE, 'utf8').catch(() => '{"apps":{}}');
  const parsed = JSON.parse(data);
  return Object.entries(parsed.apps || {}).map(([id, app]) => ({ id, ...app }));
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
  const { stdout } = await execFileAsync('pm2', ['jlist']);
  const stripped = stdout.replace(/\x1b\[[0-9;]*m/g, '');
  const jsonStart = stripped.indexOf('[{');
  const jsonEnd = stripped.lastIndexOf('}]');

  if (jsonStart < 0 || jsonEnd < 0) {
    console.error('[Autofixer] Invalid pm2 jlist output');
    return [];
  }

  return JSON.parse(stripped.substring(jsonStart, jsonEnd + 2));
}

// Get error logs for a process
async function getProcessLogs(processName) {
  const { stdout: errLogs } = await execFileAsync('pm2', ['logs', processName, '--lines', '100', '--nostream', '--err']).catch(() => ({ stdout: '' }));
  const { stdout: outLogs } = await execFileAsync('pm2', ['logs', processName, '--lines', '50', '--nostream', '--out']).catch(() => ({ stdout: '' }));
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

  console.log(`[Autofixer] Starting fix for ${processName}: ${sessionId}`);

  const prompt = `You are an autonomous autofixer for PortOS. A PM2-managed process has crashed and needs to be fixed.

**CRITICAL INSTRUCTIONS:**
1. Analyze the error logs below to understand what caused the crash
2. Read relevant source files to understand the issue
3. Fix the bug by editing the necessary files
4. After fixing, run: pm2 restart ${processName}
5. Verify the process starts successfully by checking pm2 list
6. If it still fails, analyze the new error and try again (max 2 attempts)

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
Fix the issue and restart the process. Be systematic and thorough. Use the Bash tool to restart PM2 after making your fixes.`;

  await ensureHistoryDir();

  const outputBuffer = [];

  return new Promise((resolve) => {
    const child = spawn('claude', ['-p', prompt], {
      cwd: app.repoPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false
    });

    child.stdout.on('data', (data) => {
      const output = data.toString();
      outputBuffer.push(output);
      process.stdout.write(output);
    });

    child.stderr.on('data', (data) => {
      const output = data.toString();
      outputBuffer.push(`[STDERR] ${output}`);
      process.stderr.write(output);
    });

    child.on('close', async (code) => {
      const endTime = new Date().toISOString();
      const duration = new Date(endTime).getTime() - new Date(startTime).getTime();
      const output = outputBuffer.join('');
      const success = code === 0;

      console.log(`${success ? '[Autofixer] Fix successful' : '[Autofixer] Fix failed'} for ${processName} (exit code: ${code})`);

      const metadata = {
        sessionId,
        startTime,
        endTime,
        duration,
        exitCode: code,
        success,
        processName,
        appName: app.name,
        appId: app.id,
        repoPath: app.repoPath,
        type: 'autofixer'
      };

      await saveSession(sessionId, prompt, output, metadata);
      console.log(`[Autofixer] Saved session: ${sessionId}`);

      if (success) {
        markAsFixed(processName);
      }

      resolve({ success, sessionId, output });
    });

    child.on('error', async (error) => {
      const endTime = new Date().toISOString();
      const duration = new Date(endTime).getTime() - new Date(startTime).getTime();
      const output = outputBuffer.join('') + `\n[ERROR] ${error.message}`;

      console.error(`[Autofixer] Error fixing ${processName}:`, error.message);

      const metadata = {
        sessionId,
        startTime,
        endTime,
        duration,
        exitCode: -1,
        success: false,
        processName,
        appName: app.name,
        appId: app.id,
        repoPath: app.repoPath,
        type: 'autofixer',
        error: error.message
      };

      await saveSession(sessionId, prompt, output, metadata);
      resolve({ success: false, sessionId, output, error: error.message });
    });
  });
}

// Main check function
async function checkAndFixProcesses() {
  console.log('[Autofixer] Checking PM2 processes...');

  const monitoredProcesses = await getMonitoredProcesses();

  if (monitoredProcesses.length === 0) {
    console.log('[Autofixer] No apps registered in PortOS');
    return;
  }

  console.log(`[Autofixer] Monitoring ${monitoredProcesses.length} process(es): ${monitoredProcesses.join(', ')}`);

  const pm2List = await getProcessList();

  if (pm2List.length === 0) {
    console.log('[Autofixer] No PM2 processes found');
    return;
  }

  const crashedProcesses = pm2List.filter(proc => {
    const status = proc.pm2_env?.status;
    return status === 'errored' && monitoredProcesses.includes(proc.name);
  });

  if (crashedProcesses.length === 0) {
    console.log('[Autofixer] All monitored processes healthy');
    return;
  }

  console.log(`[Autofixer] Found ${crashedProcesses.length} crashed process(es)`);

  for (const proc of crashedProcesses) {
    const processName = proc.name;

    if (isOnCooldown(processName)) {
      console.log(`[Autofixer] ${processName} is on cooldown, skipping`);
      continue;
    }

    const app = await findAppByProcess(processName);
    if (!app) {
      console.log(`[Autofixer] No app found for process ${processName}, skipping`);
      continue;
    }

    console.log(`[Autofixer] Attempting to fix ${processName} (${app.name})...`);

    const { errLogs, outLogs } = await getProcessLogs(processName);
    await fixProcess(processName, app, errLogs, outLogs);
  }
}

// Main loop
async function main() {
  console.log('[Autofixer] Starting PortOS Autofixer daemon');
  console.log(`[Autofixer] Check interval: ${CHECK_INTERVAL / 60000} minutes`);
  console.log(`[Autofixer] Fix cooldown: ${FIX_COOLDOWN / 60000} minutes per process`);

  await ensureHistoryDir();

  // Initial check
  await checkAndFixProcesses();

  // Periodic check
  setInterval(async () => {
    await checkAndFixProcesses();
  }, CHECK_INTERVAL);
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Autofixer] Shutting down...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[Autofixer] Shutting down...');
  process.exit(0);
});

// Start
main().catch(error => {
  console.error('[Autofixer] Fatal error:', error);
  process.exit(1);
});
