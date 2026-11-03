/** Positive, workspace-scoped checks for legacy children without IDs in argv. */
import { lstat, readFile, readlink } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from '../lib/childProcess.js';
import { parseCommandArgs, validateCommand } from '../lib/commandSecurity.js';
import { expandHome } from '../lib/paths.js';
import { escapeRegExp } from '../lib/textUtils.js';

const runFile = promisify(execFile);
const CLI = /(?:^|[\s/\\'"=])(?:claude|codex|gemini|grok|agy|antigravity|opencode|pi|cursor-agent)(?:[\s./\\'"-]|$)/i;
const APP_CHILD = /(?:^|[\s/\\'"=])(?:git|npm|npx|pnpm|yarn|bun)(?:[\s./\\'"-]|$)|\b(?:update\.(?:sh|ps1)|deploy\.sh)\b/i;
const OWN_SERVICES = /[\\/]server[\\/](?:start\.js|cos-runner[\\/]index\.js)|[\\/]browser[\\/]server\.js|[\\/]autofixer[\\/](?:server|ui)\.js/i;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,200}$/i;
const executable = value => basename(String(value ?? '').replaceAll('\\', '/')).toLowerCase();
function codexService(command) {
  let args = parseCommandArgs(String(command ?? '').trim());
  if (/^cmd(?:\.exe)?$/.test(executable(args[0])) && args[1]?.toLowerCase() === '/c') args = args.slice(2);
  if (/^node(?:js|\.exe)?$/.test(executable(args[0])) && executable(args[1]) === 'codex.js') args = args.slice(1);
  if (!/^codex(?:\.exe|\.cmd|\.js)?$/.test(executable(args[0])) || args[1] !== 'app-server') return null;
  if (args.includes('--managed-daemon') || (args.length === 4 && args[2] === 'daemon' && args[3] === 'pid-update-loop')) return 'shared';
  return args.length === 2 ? 'stdio' : null;
}

async function readRun(data, id) {
  if (!SAFE_ID.test(id)) return null;
  const path = join(data, 'runs', id, 'metadata.json');
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > 1024 * 1024) return null;
    return JSON.parse(await readFile(path, 'utf8'));
  } catch { return null; }
}

async function readJob(data, id) {
  try {
    const path = join(data, 'cos', 'autonomous-jobs.json');
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return null;
    const store = JSON.parse(await readFile(path, 'utf8'));
    return Array.isArray(store.jobs) ? store.jobs.find(job => job.id === id) ?? null : null;
  } catch { return null; }
}

function commandPattern(command) {
  const validated = typeof command === 'string' ? validateCommand(command) : null;
  if (!validated?.valid) return null;
  const name = escapeRegExp(basename(validated.baseCommand));
  const script = /^(?:node|python\d*)$/i.test(name)
    ? validated.args?.find(arg => /\.(?:m?js|cjs|py|ts)$/i.test(arg)) : null;
  const suffix = script ? `.*${escapeRegExp(basename(script))}` : '';
  return new RegExp(`(?:^|[\\s/\\\\'"=])${name}(?:[\\s./\\\\'"-]|$)${suffix}`, 'i');
}

function providerCommandPattern(command) {
  if (typeof command !== 'string') return null;
  const executable = parseCommandArgs(command)[0];
  if (!executable) return null;
  const name = escapeRegExp(executable.replaceAll('\\', '/').split('/').at(-1));
  return new RegExp(`(?:^|[\\s/\\\\'"=])${name}(?:[\\s./\\\\'"-]|$)`, 'i');
}

async function cwdByPid(pids, { platform = process.platform, run = runFile } = {}) {
  if (!pids.length) return new Map();
  if (platform === 'linux') {
    const rows = await Promise.all(pids.map(async pid => [pid, await readlink(`/proc/${pid}/cwd`).catch(() => null)]));
    return new Map(rows.filter(([, cwd]) => cwd));
  }
  if (platform !== 'darwin') return new Map();
  const stdout = await run('lsof', ['-a', '-d', 'cwd', '-p', pids.join(','), '-Fpn'],
    { timeout: 10000, maxBuffer: 8 * 1024 * 1024 }).then(result => result.stdout, error => {
    if (error.stdout) return error.stdout;
    throw error;
  });
  const result = new Map();
  let pid = null;
  for (const line of String(stdout).split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && Number.isSafeInteger(pid)) result.set(pid, line.slice(1));
  }
  return result;
}
export const getProcessWorkingDirectories = cwdByPid;

const inside = (cwd, workspace) => {
  const canonical = value => { try { return realpathSync(value); } catch { return resolve(value); } };
  const root = canonical(workspace);
  const path = canonical(cwd);
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
};

export async function assertNoScopedLegacyProcesses(operations, processes, { data, codeRoot, loadApp, loadAgent = async () => null,
  loadProvider = async () => null, loadRun = id => readRun(data, id),
  loadJob = id => readJob(data, id), probeCwds = cwdByPid, selfPid = process.pid, updatePid = null,
  idleProviderServices = false, platform = process.platform } = {}) {
  const limitations = [];
  const byPid = new Map(processes.map(proc => [proc.pid, proc]));
  const ownedStdio = proc => {
    if (codexService(proc.command) !== 'stdio' || !codeRoot) return false;
    let parent = byPid.get(proc.ppid);
    if (parent && codexService(parent.command) === 'stdio') parent = byPid.get(parent.ppid);
    const [binary, script] = parseCommandArgs(String(parent?.command ?? '').trim());
    return /^node(?:js|\.exe)?$/.test(executable(binary)) && isAbsolute(script ?? '')
      && ['start.js', 'index.js'].some(name => resolve(script) === resolve(codeRoot, 'server', name));
  };
  if (!idleProviderServices && processes.some(ownedStdio))
    throw Object.assign(new Error('The older runtime cannot report all provider calls. Use an acknowledged manual update to restart it.'), { code: 'MAINTENANCE_STALE' });
  const providerPattern = async id => {
    const provider = id ? await loadProvider(id).catch(() => null) : null;
    const custom = providerCommandPattern(provider?.command);
    if (!custom) limitations.push('provider-command-unavailable');
    return custom ? new RegExp(`${CLI.source}|${custom.source}`, 'i') : CLI;
  };
  const scopes = (await Promise.all(operations.map(async op => {
    if (['cli-run', 'tui-run'].includes(op.kind)) {
      const run = await loadRun(op.resource).catch(() => null);
      const root = typeof run?.workspacePath === 'string' ? expandHome(run.workspacePath.trim()) : '';
      if (!isAbsolute(root)) limitations.push('run-workspace-unavailable');
      return isAbsolute(root) ? { root, pattern: await providerPattern(run.providerId), op } : null;
    }
    if (['agent', 'runner'].includes(op.kind) && op.resource.startsWith('agent-')) {
      const agent = await loadAgent(op.resource).catch(() => null);
      const raw = agent?.workspacePath ?? agent?.metadata?.workspacePath;
      const root = typeof raw === 'string' ? expandHome(raw.trim()) : '';
      if (!isAbsolute(root)) limitations.push('agent-workspace-unavailable');
      return isAbsolute(root)
        ? { root, pattern: await providerPattern(agent?.metadata?.providerId), op } : null;
    }
    if (op.kind === 'agent') {
      const task = await loadAgent(op.resource).catch(() => null);
      const app = task?.metadata?.app ? await loadApp(task.metadata.app).catch(() => null) : null;
      const raw = task?.metadata?.app ? app?.repoPath : codeRoot;
      const root = typeof raw === 'string' ? expandHome(raw.trim()) : '';
      if (!isAbsolute(root)) limitations.push('agent-workspace-unavailable');
      return isAbsolute(root) ? { root, pattern: APP_CHILD, op } : null;
    }
    if (op.kind === 'media' && SAFE_ID.test(op.resource))
      return { root: join(tmpdir(), `portos-grok-video-${op.resource}`), pattern: /(?:^|[\s/\\'"=])grok(?:[\s./\\'"-]|$)/i, op };
    if (op.kind === 'app-operation') {
      if (/^path-sha256-[a-f0-9]{64}$/.test(op.resource))
        return { rootHash: op.resource.slice('path-sha256-'.length), pattern: APP_CHILD, op };
      const app = isAbsolute(op.resource) ? { repoPath: op.resource } : await loadApp(op.resource).catch(() => null);
      const root = typeof app?.repoPath === 'string' ? expandHome(app.repoPath.trim()) : '';
      if (!isAbsolute(root)) limitations.push('app-workspace-unavailable');
      const custom = commandPattern(app?.updateCommand);
      const pattern = custom ? new RegExp(`${APP_CHILD.source}|${custom.source}`, 'i') : APP_CHILD;
      return isAbsolute(root) ? { root, pattern, op } : null;
    }
    if (op.kind === 'shell-job') {
      const job = await loadJob(op.resource).catch(() => null);
      const pattern = commandPattern(job?.command);
      return pattern && typeof codeRoot === 'string' && isAbsolute(codeRoot) ? { root: codeRoot, pattern, op } : null;
    }
    if (op.kind === 'script-job' && op.resource === 'job-moltworld-exploration'
      && typeof codeRoot === 'string' && isAbsolute(codeRoot))
      return { root: codeRoot, pattern: /moltworld-explore\.mjs/i, op };
    return null;
  }))).filter(Boolean);
  if (!scopes.length) return [...new Set(limitations)];
  const relevant = (proc, scope) => scope.pattern.test(proc.command ?? '')
    && (!Number.isFinite(proc.startedAt) || !Number.isFinite(Date.parse(scope.op.startedAt))
      || proc.startedAt >= Date.parse(scope.op.startedAt) - 2000);
  const descendedFrom = (proc, op) => {
    const seen = new Set();
    let parent = proc.ppid;
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      if (parent === op.pid) {
        const owner = byPid.get(parent);
        return !owner || !Number.isFinite(owner.startedAt) || owner.startedAt <= Date.parse(op.startedAt) + 2000;
      }
      parent = byPid.get(parent)?.ppid;
    }
    return false;
  };
  const candidates = processes.filter(proc => proc.pid !== selfPid && proc.pid !== updatePid && !String(proc.state ?? '').startsWith('Z')
    && !OWN_SERVICES.test(proc.command ?? '') && scopes.some(scope => relevant(proc, scope)));
  const cwd = await probeCwds(candidates.map(proc => proc.pid)).catch(() => {
    limitations.push('workspace-cwd-unavailable');
    return new Map();
  });
  if (platform === 'win32' && candidates.length) limitations.push('windows-cwd-unavailable');
  if (platform !== 'win32' && candidates.some(proc => !cwd.has(proc.pid))) limitations.push('workspace-cwd-partial');
  const hasRoot = (command, root) => platform === 'win32'
    ? command.replaceAll('\\', '/').toLowerCase().includes(root.replaceAll('\\', '/').toLowerCase())
    : command.includes(root);
  const hasHashedAncestor = (path, expected) => {
    let current = resolve(path);
    try { current = realpathSync(current); } catch { /* Compare the observed spelling. */ }
    for (;;) {
      if (createHash('sha256').update(current).digest('hex') === expected) return true;
      const parent = resolve(current, '..');
      if (parent === current) return false;
      current = parent;
    }
  };
  if (candidates.some(proc => scopes.some(scope => {
    if (!relevant(proc, scope)) return false;
    if (descendedFrom(proc, scope.op)) return true;
    if (ownedStdio(proc) || codexService(proc.command) === 'shared') return false;
    if (cwd.has(proc.pid) && (scope.root ? inside(cwd.get(proc.pid), scope.root) : hasHashedAncestor(cwd.get(proc.pid), scope.rootHash))) return true;
    return scope.root && hasRoot(String(proc.command ?? ''), scope.root);
  })))
    throw Object.assign(new Error('A process associated with an inspected workspace is still running.'), { code: 'MAINTENANCE_STALE' });
  return [...new Set(limitations)];
}
