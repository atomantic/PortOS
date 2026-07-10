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
import {
  sanitizeChildEnv,
  collectSecretEnvValues,
  buildFixPrompt,
  restrictedToolArgs,
  validateProposedDiff,
  isGitRepo,
  createDisposableWorktree,
  collectWorktreeDiff,
  removeWorktree,
  applyDiffToLive,
  revertDiffFromLive,
  runVerifyCommand,
} from './sandbox.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Prepend the guarded pm2 shim to this process's PATH as defense-in-depth. The
// fix agent runs in an isolated worktree with a sanitized env and (for claude)
// no Bash tool, so it should never invoke pm2 at all — but the shim keeps a
// `pm2 kill` from a non-claude provider from downing the shared daemon. Our own
// execPm2 calls use an absolute PM2_BIN, so they bypass the shim. sanitizeChildEnv
// preserves this guarded PATH into the agent's env.
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
// Disposable worktrees for isolated repair runs (gitignored under data/).
const WORKTREES_DIR = join(AUTOFIXER_DIR, 'worktrees');
// Bound the agent-proposed patch before it can reach the live checkout.
const MAX_DIFF_BYTES = 200 * 1024;

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

async function saveSession(sessionId, prompt, output, metadata, patch) {
  const sessionDir = join(SESSIONS_DIR, sessionId);
  await mkdir(sessionDir, { recursive: true });

  await writeFile(join(sessionDir, 'prompt.txt'), prompt);
  await writeFile(join(sessionDir, 'output.txt'), output);
  await writeFile(join(sessionDir, 'metadata.json'), JSON.stringify(metadata, null, 2));
  // The staged/applied patch is the human-reviewable artifact of the fix — keep
  // it beside the session so a user can inspect (and, when auto-promote is off,
  // manually apply) exactly what the agent proposed.
  if (typeof patch === 'string' && patch.trim().length > 0) {
    await writeFile(join(sessionDir, 'fix.patch'), patch);
  }

  const index = await loadIndex();
  const indexEntry = {
    sessionId: metadata.sessionId,
    startTime: metadata.startTime,
    endTime: metadata.endTime,
    duration: metadata.duration,
    success: metadata.success,
    promoted: metadata.promoted || false,
    staged: metadata.staged || false,
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

// Run an autonomous repair, ISOLATED from the live checkout.
//
// The crash logs handed to this agent are untrusted (a payload reflected into a
// process's stderr can carry injected instructions), so we never let the agent
// touch the live repository or inherit host credentials. The flow:
//   1. Require a git checkout and cut a disposable, detached worktree at HEAD.
//   2. Sanitize the child env down to system + AI-provider auth only.
//   3. Run the agent against the worktree with a fenced, untrusted-log prompt
//      and (for claude) the shell/network toolset denied.
//   4. Collect + validate the resulting diff (size/scope/forbidden paths).
//   5. Optionally verify it against a user-configured test command.
//   6. Promotion gate: only when the user opted into `autoPromote` do we apply
//      the diff to the live checkout and restart the process; otherwise the
//      validated patch is staged beside the session for manual review.
async function fixProcess(processName, app, errorLogs, outputLogs) {
  const sessionId = `autofixer_${processName}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const startTime = new Date().toISOString();

  console.log(`🔧 [Autofixer] Starting isolated fix for ${processName}: ${sessionId}`);

  await ensureHistoryDir();

  const prompt = buildFixPrompt({ processName, app, errorLogs, outputLogs });
  const outputBuffer = [];

  // Resolve the configured CLI provider/model (settings.autofixer), falling
  // back to claude-code — the historical default — when unset. The autofixer
  // edits files, so it needs an agentic CLI provider; pickCliProvider restricts
  // to type 'cli' (API chat providers can't do file edits). `autoPromote` and
  // `verifyCommand` come from the same settings slice.
  const providers = await loadProviders();
  const settings = await loadSettings();
  const autofixerCfg = settings.autofixer || {};
  const picked = pickCliProvider(providers, autofixerCfg);
  const autoPromote = autofixerCfg.autoPromote === true; // default OFF — stage only
  const verifyCommand = typeof autofixerCfg.verifyCommand === 'string' ? autofixerCfg.verifyCommand.trim() : '';

  // Single completion path — write the session record + return the result.
  const finalize = async ({ success, exitCode, error, extra = {}, patch, cooldown }) => {
    const endTime = new Date().toISOString();
    const duration = new Date(endTime).getTime() - new Date(startTime).getTime();
    const output = outputBuffer.join('') + (error ? `\n[ERROR] ${error}` : '');

    console.log(`${success ? '✅ [Autofixer] Fix produced' : '❌ [Autofixer] Fix failed'} for ${processName} (exit code: ${exitCode})`);

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
      isolated: true,
      autoPromote,
      provider: picked.provider?.id || null,
      model: picked.model || null,
      ...extra,
      ...(error ? { error } : {}),
    };

    await saveSession(sessionId, prompt, output, metadata, patch);
    console.log(`💾 [Autofixer] Saved session: ${sessionId}`);

    // Cool down whenever a usable fix was produced (promoted, staged, OR
    // applied-but-restart-failed) — not just on full success — so a crash the
    // agent already addressed doesn't re-trigger the LLM every 15-min cycle.
    if (cooldown ?? success) markAsFixed(processName);
    return { success, sessionId, output, ...(error ? { error } : {}) };
  };

  if (picked.error) {
    outputBuffer.push(`[ERROR] ${picked.error}`);
    console.error(`❌ [Autofixer] ${picked.error}`);
    return finalize({ success: false, exitCode: -1, error: picked.error });
  }

  // ISOLATION REQUIREMENT: no git checkout ⇒ no rollback boundary ⇒ we refuse
  // to run an autonomous, file-editing agent driven by untrusted logs.
  if (!(await isGitRepo(app.repoPath))) {
    const reason = `refusing autonomous repair: ${app.repoPath} is not a git checkout (no rollback boundary)`;
    console.error(`🛑 [Autofixer] ${reason}`);
    return finalize({ success: false, exitCode: -1, error: reason, extra: { isolated: false } });
  }

  const wt = await createDisposableWorktree(app.repoPath, WORKTREES_DIR, sessionId);
  if (wt.error) {
    console.error(`🛑 [Autofixer] Could not isolate ${processName}: ${wt.error}`);
    return finalize({ success: false, exitCode: -1, error: `worktree isolation failed: ${wt.error}`, extra: { isolated: false } });
  }
  const worktreePath = wt.path;
  // Strip host credentials the agent has no business seeing — it keeps only
  // system + AI-provider auth. provider.envVars still overlays inside the runner.
  const childEnv = sanitizeChildEnv(process.env);

  console.log(`🤖 [Autofixer] Repairing ${processName} in isolated worktree via ${picked.provider.id}${picked.model ? ` (${picked.model})` : ''}`);

  const result = await runCliProviderPrompt({
    provider: picked.provider,
    model: picked.model,
    prompt,
    cwd: worktreePath,
    baseEnv: childEnv,
    extraArgs: restrictedToolArgs(picked.provider),
    timeoutMs: 600000, // 10 min — a fix may need several read/edit cycles
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

  // Collect the agent's edits as a diff BEFORE tearing down the worktree. A
  // spawn failure / timeout can leave a partial edit — don't promote or stage
  // work from an agent that didn't finish cleanly.
  const diff = await collectWorktreeDiff(worktreePath);
  const agentOk = !result.error;
  // The live env's provider-auth values (incl. runner-injected provider.envVars
  // keys) — reject any diff that tries to write one into the repo (agent
  // read-then-promote exfil backstop).
  const secretValues = collectSecretEnvValues(childEnv, picked.provider?.envVars);
  const validation = agentOk
    ? validateProposedDiff(diff, { maxBytes: MAX_DIFF_BYTES, secretValues })
    : { ok: false, reason: `agent did not complete: ${result.error}`, files: [] };

  // Optional verification against the user-configured test command, run in the
  // isolated worktree with the sanitized env — before anything reaches live.
  let verify = null;
  if (validation.ok && verifyCommand) {
    console.log(`🧪 [Autofixer] Verifying ${processName} fix: ${verifyCommand}`);
    verify = await runVerifyCommand(verifyCommand, worktreePath, childEnv);
    outputBuffer.push(`\n[VERIFY exit ${verify.code}]\n${verify.output}`);
  }
  const verifyOk = !verifyCommand || (verify && verify.ok);

  // Promotion gate — only a validated (and, if configured, verified) diff may
  // touch the live checkout, and only when the user explicitly opted in.
  let promoted = false;
  let staged = false;
  let promotionError = null;
  if (validation.ok && verifyOk) {
    if (autoPromote) {
      const applied = await applyDiffToLive(app.repoPath, diff, AUTOFIXER_DIR);
      if (applied.ok) {
        const restart = await execPm2(['restart', processName]).catch((e) => ({ error: e.message }));
        promoted = !restart.error;
        promotionError = restart.error || null;
        if (promoted) {
          console.log(`🚀 [Autofixer] Promoted + restarted ${processName}`);
        } else {
          // Applied cleanly but the restart failed — roll the patch back so the
          // live tree isn't left mutated (which would make the next cycle
          // double-apply or fail `git apply --check` forever).
          const reverted = await revertDiffFromLive(app.repoPath, diff, AUTOFIXER_DIR);
          console.error(`❌ [Autofixer] Restart failed, rolled back applied fix for ${processName}: ${restart.error}${reverted.error ? ` (rollback also failed: ${reverted.error})` : ''}`);
        }
      } else {
        promotionError = applied.error;
        console.error(`❌ [Autofixer] Promotion blocked: ${applied.error}`);
      }
    } else {
      staged = true;
      console.log(`📋 [Autofixer] Fix staged for review (auto-promote off): ${sessionId}`);
    }
  } else {
    console.warn(`⚠️ [Autofixer] Fix not promotable: ${validation.reason || (verify && `verify exit ${verify.code}`) || 'unknown'}`);
  }

  // Always discard the disposable worktree.
  await removeWorktree(app.repoPath, worktreePath);

  const producedFix = validation.ok && verifyOk; // usable fix, regardless of restart outcome
  const success = producedFix && (autoPromote ? promoted : true);
  return finalize({
    success,
    cooldown: producedFix,
    exitCode: result.exitCode ?? -1,
    error: result.error || promotionError || (!validation.ok ? validation.reason : null) || null,
    patch: validation.ok ? diff : undefined,
    extra: {
      promoted,
      staged,
      diffBytes: Buffer.byteLength(diff || '', 'utf8'),
      changedFiles: validation.files,
      diffValid: validation.ok,
      ...(validation.ok ? {} : { diffRejectedReason: validation.reason }),
      ...(verify ? { verify: { ran: true, ok: verify.ok, exitCode: verify.code } } : { verify: { ran: false } }),
    },
  });
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

// Main loop
async function main() {
  console.log(`🚀 [Autofixer] Starting PortOS Autofixer daemon`);
  console.log(`⏱️ [Autofixer] Check interval: ${CHECK_INTERVAL / 60000} minutes`);
  console.log(`⏳ [Autofixer] Fix cooldown: ${FIX_COOLDOWN / 60000} minutes per process`);

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
  console.log(`\n🛑 [Autofixer] Shutting down...`);
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log(`\n🛑 [Autofixer] Shutting down...`);
  process.exit(0);
});

// Start
main().catch(error => {
  console.error('💥 [Autofixer] Fatal error:', error?.message || String(error), error?.stack);
  process.exit(1);
});
