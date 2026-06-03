import { spawn } from 'child_process';
import { join } from 'path';
import { access } from 'fs/promises';

/** Async equivalent of existsSync — returns true if the path is accessible */
const pathExists = (p) => access(p).then(() => true).catch(() => false);

// Allowlist of safe build commands
export const ALLOWED_BUILD_CMDS = new Set([
  'npm',        // Node.js
  'npx',        // Node.js
  'xcodebuild', // Xcode
  'swift',      // Swift Package Manager
  'make',       // Make
  'cargo'       // Rust
]);

const IS_WIN32 = process.platform === 'win32';
// npm/npx are .cmd shims on Windows — enable shell only for these so cmd.exe
// can resolve them, without enabling shell metacharacter interpretation for
// native binaries (xcodebuild, swift, make, cargo).
const WIN_CMD_SHIMS = new Set(['npm', 'npx']);
const needsShell = (cmd) => IS_WIN32 && WIN_CMD_SHIMS.has(cmd);
// Actual cmd.exe metacharacters (& | < > ^ % ! and grouping parens).
// Validated only when shell is active (needsShell guard at call site).
const SHELL_UNSAFE_RE = /[&|<>^%!()]/;
/**
 * True if any arg contains a cmd.exe metacharacter. Pure and
 * platform-independent so the shell-safety check is testable on every platform
 * (the `needsShell` gate that actually applies it stays at the call site).
 */
export const hasShellUnsafeArg = (args) => args.some(a => SHELL_UNSAFE_RE.test(a));
// On Windows, SIGTERM kills cmd.exe but orphans its child (npm). Use taskkill
// /T /F to terminate the whole process tree.
const killProc = (child) => {
  if (IS_WIN32 && child.pid) {
    spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
  } else {
    child.kill('SIGTERM');
  }
};
const INSTALL_TIMEOUT_MS = 3 * 60 * 1000;
const BUILD_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_BUILD_COMMAND = 'npm run build';

/**
 * Validate and split a build command.
 * @returns {{ ok: true, cmd, args, buildCommand }} when valid (buildCommand is
 *          the resolved string, with the default applied), or
 *          {{ ok: false, message, code: 'INVALID_BUILD_COMMAND' }} when not —
 *          so the route can map a bad command to HTTP 400 without try/catch.
 */
export function parseBuildCommand(buildCommand) {
  const resolved = buildCommand || DEFAULT_BUILD_COMMAND;
  const [cmd, ...args] = resolved.split(/\s+/);

  if (!ALLOWED_BUILD_CMDS.has(cmd)) {
    return {
      ok: false,
      code: 'INVALID_BUILD_COMMAND',
      message: `Build command '${cmd}' is not allowed. Allowed: ${[...ALLOWED_BUILD_CMDS].join(', ')}`,
      buildCommand: resolved
    };
  }

  if (needsShell(cmd) && hasShellUnsafeArg(args)) {
    return { ok: false, code: 'INVALID_BUILD_COMMAND', message: 'Build command args contain shell-unsafe characters', buildCommand: resolved };
  }

  return { ok: true, cmd, args, buildCommand: resolved };
}

/**
 * Run `npm install` in a single directory.
 * @returns {Promise<{success, exitCode, output}>} — resolves (never rejects).
 */
function runNpmInstall(subDir) {
  return new Promise((resolve) => {
    const child = spawn('npm', ['install'], { cwd: subDir, windowsHide: true, shell: needsShell('npm') });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; killProc(child); resolve({ success: false, exitCode: -1, output: `npm install timed out after ${INSTALL_TIMEOUT_MS / 1000}s` }); }
    }, INSTALL_TIMEOUT_MS);
    child.stdout.on('data', d => { stdout += d; if (stdout.length > MAX_OUTPUT_BYTES) stdout = stdout.slice(-MAX_OUTPUT_BYTES); });
    child.stderr.on('data', d => { stderr += d; if (stderr.length > MAX_OUTPUT_BYTES) stderr = stderr.slice(-MAX_OUTPUT_BYTES); });
    child.on('close', exitCode => { if (!settled) { settled = true; clearTimeout(timer); resolve({ success: exitCode === 0, exitCode, output: (stderr.trim() || stdout.trim()).slice(-1024) }); } });
    child.on('error', err => { if (!settled) { settled = true; clearTimeout(timer); resolve({ success: false, exitCode: -1, output: err.message }); } });
  });
}

/**
 * Run the build command in `repoPath`.
 * @returns {Promise<{success, stdout, stderr, code, signal, output}>} — resolves (never rejects).
 */
function runBuild(cmd, args, repoPath) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: repoPath, windowsHide: true, shell: needsShell(cmd) });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        killProc(child);
        const timeoutMsg = `Build timed out after ${BUILD_TIMEOUT_MS / 1000}s`;
        const tail = (stderr.trim() || stdout.trim()).slice(-512);
        resolve({ success: false, stderr: timeoutMsg, code: -1, output: tail ? `${timeoutMsg} — last output: ${tail}` : timeoutMsg });
      }
    }, BUILD_TIMEOUT_MS);
    child.stdout.on('data', d => {
      stdout += d;
      if (stdout.length > MAX_OUTPUT_BYTES) stdout = stdout.slice(-MAX_OUTPUT_BYTES);
    });
    child.stderr.on('data', d => {
      stderr += d;
      if (stderr.length > MAX_OUTPUT_BYTES) stderr = stderr.slice(-MAX_OUTPUT_BYTES);
    });
    child.on('close', (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        const output = (stderr.trim() || stdout.trim()).slice(-1024);
        resolve({ success: code === 0, stdout: stdout.trim(), stderr: stderr.trim(), code, signal, output });
      }
    });
    child.on('error', err => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ success: false, stderr: err.message, code: -1, signal: null, output: err.message });
      }
    });
  });
}

/**
 * Build an app's production UI: install dependencies (root + common subdirs for
 * Node apps) then run the validated build command.
 *
 * Resolves (never rejects) with a structured result the route maps to HTTP:
 *   - { success: false, failure: 'validation', code, message }   → 400
 *   - { success: false, failure: 'install', label, exitCode, output } → 500
 *   - { success: false, failure: 'build', code, signal, output }  → 500
 *   - { success: true, output }   (build stdout)                  → 200
 *
 * @param {object} app - app object (id, name, repoPath, buildCommand?)
 * @returns {Promise<object>} structured build result
 */
export async function buildApp(app) {
  const parsed = parseBuildCommand(app.buildCommand);
  if (!parsed.ok) {
    return { success: false, failure: 'validation', code: parsed.code, message: parsed.message, buildCommand: parsed.buildCommand };
  }
  const { cmd, args, buildCommand } = parsed;

  console.log(`🔨 Building ${app.name}: ${buildCommand}`);

  // Install dependencies before building (root + common subdirs) - skip for non-Node apps
  // For self-builds, skip server/ install to avoid triggering PM2 watch restart
  const isNodeApp = ['npm', 'npx'].includes(cmd);
  const isSelfBuild = app.id === 'portos-default';
  const installDirs = isNodeApp ? ['', 'client', ...(isSelfBuild ? [] : ['server']), 'admin'] : [];
  for (const sub of installDirs) {
    const subDir = sub ? join(app.repoPath, sub) : app.repoPath;
    if (await pathExists(join(subDir, 'package.json'))) {
      const label = sub || 'root';
      console.log(`📦 Installing ${label} dependencies for ${app.name}`);
      const installResult = await runNpmInstall(subDir);
      if (!installResult.success) {
        console.log(`❌ npm install (${label}) exit=${installResult.exitCode}: ${installResult.output.slice(-300)}`);
        return { success: false, failure: 'install', label, exitCode: installResult.exitCode, output: installResult.output, buildCommand };
      }
    }
  }

  const result = await runBuild(cmd, args, app.repoPath);
  console.log(`${result.success ? '✅' : '❌'} Build ${result.success ? 'complete' : 'failed'} for ${app.name}`);

  if (!result.success) {
    return { success: false, failure: 'build', code: result.code, signal: result.signal, output: result.output, buildCommand };
  }

  return { success: true, output: result.stdout, buildCommand };
}
