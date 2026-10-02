/**
 * Code Animation production execution capability (#9388): operator-owned tool
 * configuration, an on-demand adversarial containment probe, and the
 * fail-closed readiness report later render stages gate on. Nothing here runs
 * at boot or calls a provider.
 */
import { createServer } from 'node:net';
import { constants } from 'node:fs';
import { access, lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { validateRequest } from '../../lib/validation.js';
import {
  codeAnimationExecutionToolsSchema, codeAnimationToolRoots, codeAnimationWorkerEnv, codeAnimationWorkerLimitsSchema,
} from '../../lib/codeAnimationContainment.js';
import { getSettings, updateSettings } from '../settings.js';
import { cdpRequest } from '../browserService.js';
import { currentContainmentMechanism, runContainedWorker } from './containedWorker.js';
import { probeBlenderRender } from './blenderProbe.js';

const SETTINGS_KEY = 'codeAnimationExecution';
const WORKSPACE_DIR = 'code-animation-workspaces';
// Characters that could break out of a Seatbelt string literal. Backslash is
// the Windows separator; Windows has no worker mechanism, so it only matters on POSIX.
const UNSAFE_PATH = process.platform === 'win32' ? /["()\0\r\n]/ : /["\\()\0\r\n]/;

// The browser lane reuses the HTML-composition renderer sandbox unchanged.
const BROWSER_LANE = {
  mechanism: 'chromium-cdp-sandbox',
  boundary: [
    'Assets are an in-memory snapshot of the staged directory; symlinks and paths outside it are refused.',
    'Every request is intercepted: only the snapshot origin is fulfilled; network, WebSocket, WebRTC, workers, frames and popups are refused.',
    'Each render uses a disposable browser context with no cookies or credentials, closed on cancel or failure.',
  ],
  limits: [
    'Runs inside the shared managed Chromium; its renderer sandbox, not a PortOS-owned process group, contains page code.',
    'Bounded by per-command timeouts and render cancellation; no per-render memory cap.',
    'Page code can write nothing to disk.',
  ],
};

let lastProbe = null;
let probing = null;

const inside = (root, path) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
};

/**
 * Validate an operator-supplied executable: `{ executable: realpath, fingerprint, problem: null }`
 * or a problem. The fingerprint ties containment evidence to these exact bytes on disk.
 */
async function inspectExecutable(path) {
  if (!path) return { executable: null, problem: 'Not configured.' };
  if (!isAbsolute(path) || UNSAFE_PATH.test(path)) return { executable: null, problem: 'Enter an absolute path without quote, backslash or parenthesis characters.' };
  const executable = await realpath(path).catch(() => null);
  if (!executable || UNSAFE_PATH.test(executable)) return { executable: null, problem: 'The executable was not found.' };
  const info = await lstat(executable).catch(() => null);
  if (!info?.isFile() || !(await access(executable, constants.X_OK).then(() => true, () => false))) {
    return { executable: null, problem: 'The path is not an executable file.' };
  }
  const data = await realpath(PATHS.data).catch(() => PATHS.data);
  const home = await realpath(homedir()).catch(() => homedir());
  // Workers may read the tool's roots; they must never expose PortOS data or the home directory.
  if (inside(data, executable) || codeAnimationToolRoots(executable).some((root) => inside(root, data) || inside(root, home))) {
    return { executable: null, problem: 'Install the tool in its own application bundle or directory, outside PortOS data and not directly in the home directory.' };
  }
  return { executable, fingerprint: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`, problem: null };
}

async function configuredTools() {
  const parsed = codeAnimationExecutionToolsSchema.safeParse((await getSettings())?.[SETTINGS_KEY]);
  return parsed.success ? parsed.data : { blender: { executable: null } };
}

function blenderLane(mechanism, blender) {
  if (!mechanism.supported) return { ready: false, reason: mechanism.reason };
  if (!blender.executable) return { ready: false, reason: `Blender: ${blender.problem}` };
  const evidence = lastProbe?.tools?.blender;
  if (!lastProbe?.passed) return { ready: false, reason: 'Run the containment check; execution stays refused until it passes on this server process.' };
  if (!evidence || evidence.executable !== blender.executable || evidence.fingerprint !== blender.fingerprint) {
    return { ready: false, reason: 'The configured Blender changed since the last containment check.' };
  }
  if (!evidence.passed) return { ready: false, reason: 'Blender did not render the supported test scene under containment.' };
  return { ready: true, reason: null };
}

export async function getCodeAnimationExecution() {
  const mechanism = await currentContainmentMechanism();
  const blender = await inspectExecutable((await configuredTools()).blender.executable);
  return {
    platform: process.platform, mechanism, probe: lastProbe,
    tools: { blender },
    lanes: { browser: BROWSER_LANE, blender: blenderLane(mechanism, blender) },
    defaultLimits: codeAnimationWorkerLimitsSchema.parse({}),
  };
}

export async function setCodeAnimationExecutionTools(input) {
  const tools = validateRequest(codeAnimationExecutionToolsSchema, input);
  let executable = null;
  if (tools.blender.executable) {
    const inspected = await inspectExecutable(tools.blender.executable);
    if (inspected.problem) throw new ServerError(inspected.problem, { status: 400, code: 'CODE_ANIMATION_TOOL_INVALID' });
    executable = inspected.executable;
  }
  await updateSettings({ [SETTINGS_KEY]: { blender: { executable } } });
  return getCodeAnimationExecution();
}

// Synthetic adversarial package. It reports only allowed/denied codes, never
// any content it managed to read.
const BOUNDARY_SCRIPT = String.raw`
const fs = require('fs'); const net = require('net'); const cp = require('child_process');
const [canary, dataDir, homeDir, port] = process.argv.slice(2);
const attempt = (fn) => { try { fn(); return { allowed: true }; } catch (e) { return { allowed: false, code: e.code || 'ERROR' }; } };
const connect = (options) => new Promise((resolve) => {
  const socket = net.connect(options);
  const timer = setTimeout(() => { socket.destroy(); resolve({ allowed: false, code: 'TIMEOUT' }); }, 3000);
  socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve({ allowed: true }); });
  socket.once('error', (e) => { clearTimeout(timer); resolve({ allowed: false, code: e.code || 'ERROR' }); });
});
(async () => {
  const report = {
    readOutside: attempt(() => fs.readFileSync(canary)),
    listData: attempt(() => fs.readdirSync(dataDir)),
    listHome: attempt(() => fs.readdirSync(homeDir)),
    writeOutside: attempt(() => fs.writeFileSync(canary + '.written', 'x')),
    writeInput: attempt(() => fs.writeFileSync(__dirname + '/written.txt', 'x')),
    spawnProcess: attempt(() => { const r = cp.spawnSync('/bin/sh', ['-c', 'exit 0']); if (r.error) throw r.error; }),
    oversizedFile: attempt(() => fs.writeFileSync(process.env.PORTOS_WORKER_OUTPUT + '/big.bin', Buffer.alloc(2 * 1024 * 1024))),
    envKeys: Object.keys(process.env).sort(),
    loopback: await connect({ host: '127.0.0.1', port: Number(port) }),
    remote: await connect({ host: '192.0.2.10', port: 443 }),
  };
  fs.rmSync(process.env.PORTOS_WORKER_OUTPUT + '/big.bin', { force: true });
  fs.writeFileSync(process.env.PORTOS_WORKER_OUTPUT + '/report.json', JSON.stringify(report));
})();
`;

const LIMIT_SCRIPTS = {
  time: 'for (;;) {}',
  disk: `let n = 0; setInterval(() => require('fs').writeFileSync(process.env.PORTOS_WORKER_OUTPUT + '/f' + (n++), Buffer.alloc(64 * 1024, 1)), 5);`,
  memory: 'const held = Buffer.alloc(512 * 1024 * 1024, 1); for (;;) { held[0] += 1; }',
  cancel: 'for (;;) {}',
};

// PortOS's own interpreter stands in for a configured tool: the same staging,
// sandbox, environment and limits, running synthetic hostile scripts.
const probeTool = (extra = []) => ({ executable: process.execPath, argv: (entry) => [entry, ...extra] });

const denied = (result, code = 'EPERM') => result && result.allowed === false && result.code === code;

async function probeBoundary(workspaceRoot) {
  const scratch = await mkdtemp(join(tmpdir(), 'portos-containment-canary-'));
  const canary = join(scratch, 'canary.txt');
  await writeFile(canary, 'containment canary\n');
  let connections = 0;
  const listener = createServer((socket) => { connections += 1; socket.destroy(); });
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  try {
    let report = null;
    const run = await runContainedWorker({
      tool: probeTool([canary, await realpath(PATHS.data).catch(() => PATHS.data), homedir(), String(listener.address().port)]),
      workspaceRoot, entrypoint: 'probe.cjs', tickMs: 200,
      files: [{ path: 'probe.cjs', content: BOUNDARY_SCRIPT }],
      limits: { wallSeconds: 30, diskBytes: 1024 * 1024, maxFiles: 64, memoryBytes: 1024 * 1024 * 1024, openFiles: 256 },
      onOutput: async (dir) => { report = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')); },
    });
    if (!report) return [{ id: 'worker-runs', passed: false, detail: `The contained worker did not complete (${run.status}${run.reason ? `: ${run.reason}` : ''}).` }];
    // /bin/sh (which applies the rlimits before exec) adds its own bookkeeping.
    const allowedEnv = new Set([...Object.keys(codeAnimationWorkerEnv('/')), 'PWD', 'OLDPWD', 'SHLVL', '_']);
    const inherited = (report.envKeys || []).filter((key) => !allowedEnv.has(key));
    return [
      { id: 'worker-runs', passed: true, detail: 'Positive control: the worker ran and wrote its report to the output directory.' },
      { id: 'read-outside', passed: denied(report.readOutside), detail: 'A file outside the workspace could not be read.' },
      { id: 'list-data', passed: denied(report.listData), detail: 'The PortOS data directory could not be listed.' },
      { id: 'list-home', passed: denied(report.listHome), detail: 'The home directory could not be listed.' },
      { id: 'write-outside', passed: denied(report.writeOutside), detail: 'Nothing could be written outside the workspace.' },
      { id: 'write-input', passed: denied(report.writeInput), detail: 'Staged input is read-only.' },
      { id: 'spawn-process', passed: denied(report.spawnProcess), detail: 'No shell, installer or other process could be started.' },
      { id: 'file-size', passed: report.oversizedFile?.allowed === false, detail: 'A single file larger than the disk limit could not be written.' },
      { id: 'credentials', passed: Array.isArray(report.envKeys) && inherited.length === 0, detail: inherited.length ? `Unexpected inherited variables: ${inherited.length}.` : 'The environment contained only the worker’s own paths; no PortOS token or credential was inherited.' },
      { id: 'host-api', passed: denied(report.loopback) && connections === 0, detail: 'Loopback (where PortOS and local services listen) was unreachable.' },
      { id: 'network', passed: denied(report.remote), detail: 'Outbound network was refused by the sandbox.' },
    ];
  } finally {
    listener.close();
    await rm(scratch, { recursive: true, force: true });
  }
}

async function probeLimit(workspaceRoot, kind, limits, expected) {
  const controller = new AbortController();
  const timer = kind === 'cancel' ? setTimeout(() => controller.abort(), 300) : null;
  try {
    const run = await runContainedWorker({
      tool: probeTool(), workspaceRoot, entrypoint: 'limit.cjs', tickMs: 100, signal: controller.signal,
      files: [{ path: 'limit.cjs', content: LIMIT_SCRIPTS[kind] }],
      limits: { wallSeconds: 20, diskBytes: 1024 * 1024, maxFiles: 10_000, memoryBytes: 1024 * 1024 * 1024, openFiles: 256, ...limits },
    }).catch((error) => ({ status: 'failed', reason: error.message, processGroupClear: false }));
    return {
      id: `limit-${kind}`, passed: run.status === 'terminated' && run.reason === expected && run.processGroupClear,
      detail: `Terminated by ${run.reason ?? run.status}; process group ${run.processGroupClear ? 'empty' : 'NOT empty'} afterwards.`,
    };
  } finally { clearTimeout(timer); }
}

async function runProbe() {
  const started = Date.now();
  // Fail closed while checking, and if the check itself errors.
  lastProbe = null;
  const mechanism = await currentContainmentMechanism();
  if (!mechanism.supported) {
    lastProbe = { probedAt: new Date().toISOString(), mechanism: null, passed: false, refused: mechanism.reason, checks: [], tools: {}, browser: null, durationMs: 0 };
    return lastProbe;
  }
  const workspaceRoot = join(PATHS.data, WORKSPACE_DIR);
  const checks = [
    ...await probeBoundary(workspaceRoot),
    await probeLimit(workspaceRoot, 'time', { wallSeconds: 1 }, 'time'),
    await probeLimit(workspaceRoot, 'disk', {}, 'disk'),
    await probeLimit(workspaceRoot, 'memory', { memoryBytes: 128 * 1024 * 1024 }, 'memory'),
    await probeLimit(workspaceRoot, 'cancel', {}, 'canceled'),
  ];
  const blender = await probeBlenderRender(await inspectExecutable((await configuredTools()).blender.executable), workspaceRoot);
  const browser = await cdpRequest('/json/version', { timeout: 2000 }).then((response) => response.ok, () => false);
  lastProbe = {
    probedAt: new Date().toISOString(), mechanism: mechanism.id, passed: checks.every((check) => check.passed),
    refused: null, checks, tools: blender ? { blender } : {}, browser: { available: browser }, durationMs: Date.now() - started,
  };
  const log = lastProbe.passed ? console.log : console.error;
  log(`${lastProbe.passed ? '🛡️' : '❌'} Code Animation containment check ${lastProbe.passed ? 'passed' : 'FAILED'} (${checks.filter((check) => check.passed).length}/${checks.length})`);
  return lastProbe;
}

/** Run the adversarial self-test on demand; concurrent requests share one run. */
export async function probeCodeAnimationExecution() {
  probing ??= runProbe().finally(() => { probing = null; });
  await probing;
  return getCodeAnimationExecution();
}
