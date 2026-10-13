import { mkdtemp, readFile, readdir, realpath, stat, chmod } from 'fs/promises';
import { join, relative, isAbsolute, resolve } from 'path';
import { homedir, tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { spawn } from '../lib/childProcess.js';
import { atomicWrite, ensureDir, writeFileGuarded } from '../lib/fileCore.js';
import { killProcessTree } from '../lib/bufferedSpawn.js';
import { createContentRefusalDetector, isContentRefusalError } from '../lib/aiToolkit/errorDetection.js';
import { initialSecurityScanEvidence, securityScanGrantSchema, securityScanRequestSchema } from '../lib/securityScanEvidence.js';
import { armForceKill } from './forceKill.js';
import { cleanupSecurityScanGroup } from './securityScanRecovery.js';

const CHILD = fileURLToPath(new URL('./securityScanChild.js', import.meta.url));
const AGENT_ID = /^[a-zA-Z0-9_-]{1,200}$/;
const ENV_KEYS = new Set(['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'CODEX_HOME']);
const failure = (message, status = 409) => Object.assign(new Error(message), { status });

// Read installed package metadata only. Never run npx, download a package, or
// consult the registry while deciding whether a scan can be started.
async function resolveInstalledSecurityScanner({ home = homedir(), root = process.cwd() } = {}) {
  const candidates = [join(root, 'node_modules/@openai/codex-security')];
  const cache = join(home, '.npm/_npx');
  for (const name of (await readdir(cache).catch(() => [])).sort()) {
    if (/^[a-f0-9]+$/.test(name)) candidates.push(join(cache, name, 'node_modules/@openai/codex-security'));
  }
  for (const directory of candidates) {
    const pkg = await readFile(join(directory, 'package.json'), 'utf8').then(JSON.parse).catch(() => null);
    const bin = pkg?.bin?.['codex-security'];
    if (pkg?.name !== '@openai/codex-security' || typeof bin !== 'string') continue;
    const path = resolve(directory, bin);
    if (relative(directory, path).startsWith('..') || !(await stat(path).catch(() => null))?.isFile()) continue;
    return { command: process.execPath, args: [path], version: pkg.version };
  }
  return null;
}

async function scopePaths(cwd, values) {
  const root = await realpath(cwd);
  return Promise.all(values.map(async value => {
    const path = await realpath(resolve(root, value));
    const rel = relative(root, path);
    if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
      throw failure('Scanner context must stay inside the agent workspace', 400);
    }
    return path;
  }));
}

/** One scanner attempt, owned by the runner rather than by an agent shell. */
export function createSecurityScanManager({ agentsDir, getAgent, emitEvidence, trackWork = fn => fn(),
  resolveCli = resolveInstalledSecurityScanner, spawnProcess = spawn, kill = killProcessTree,
  environment = process.env, tempRoot = tmpdir(), graceMs = 5000, cleanupGroup = cleanupSecurityScanGroup } = {}) {
  const entries = new Map();
  const terminateRefusedOuter = id => {
    const agent = getAgent(id);
    if (!agent || agent.exited || agent.scannerRefused) return;
    agent.scannerRefused = true;
    // Independent ownership survives removal from the public outer-agent map.
    const owned = new Map([[id, agent]]);
    armForceKill(owned, id, agent, { graceMs });
    kill(agent.process, 'SIGTERM');
  };
  const evidencePath = id => {
    if (!AGENT_ID.test(id)) throw failure('Invalid agent id', 400);
    return join(agentsDir, id, 'security-scan.json');
  };
  const persist = async (id, entry) => {
    // Queue snapshots, not mutable references. The running snapshot must be
    // durable before spawn; the final one must precede outer completion.
    entry.evidence.sequence = (entry.evidence.sequence || 0) + 1;
    const snapshot = structuredClone(entry.evidence);
    entry.writes = (entry.writes || Promise.resolve()).then(async () => {
      // Live observations remain available even if the local receipt write fails.
      await emitEvidence?.(id, snapshot);
      await atomicWrite(evidencePath(id), snapshot);
    });
    return entry.writes;
  };
  const read = async id => {
    if (entries.has(id)) return entries.get(id).evidence;
    const saved = await readFile(evidencePath(id), 'utf8').then(JSON.parse).catch(err => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    // A prior runner's in-flight attempt cannot be resumed or inferred complete.
    return saved;
  };
  const register = async (id, grant) => {
    if (!grant) return;
    const parsed = securityScanGrantSchema.parse(grant);
    if (await read(id)) throw failure('Scanner grant already exists for this agent');
    const entry = { grant: Object.freeze(parsed), evidence: initialSecurityScanEvidence(parsed), attempted: false };
    entries.set(id, entry);
    await persist(id, entry);
  };
  const stop = async (id, reason = 'interrupted') => {
    const entry = entries.get(id);
    if (!entry) {
      const evidence = await read(id);
      if (evidence?.status !== 'running') return evidence;
      const owner = await readFile(join(agentsDir, id, 'security-scan-process.json'), 'utf8').then(JSON.parse).catch(() => null);
      const confirmed = await cleanupGroup(owner).catch(() => false);
      const recovered = { evidence: { ...evidence, status: 'interrupted', exitCode: null, cleanup: confirmed ? 'confirmed' : 'unconfirmed' } };
      await persist(id, recovered);
      return recovered.evidence;
    }
    // Latch even during async scope/installation checks: a Stop must win over
    // the subsequent spawn, and must never turn an already completed scan red.
    if (!entry.terminal) entry.stopReason ||= reason;
    entry.cancel?.();
    await entry.promise;
    return entry.evidence;
  };
  const start = (id, input) => {
    const request = securityScanRequestSchema.parse(input);
    const agent = getAgent(id);
    const entry = entries.get(id);
    if (!agent || agent.exited || agent.paused || !entry) throw failure('No active runner-owned security scan grant');
    // Synchronous reservation before any I/O. Replays share the same promise;
    // request loss and duplicate POSTs never authorize another provider call.
    if (entry.attempted) return entry.promise;
    if (entry.stopReason) throw failure('The scanner grant has been stopped');
    entry.attempted = true;
    entry.promise = trackWork(async () => {
      let directory;
      let forceTimer;
      let deadline;
      let drainTimer;
      try {
        const [paths, knowledgeBase, cli] = await Promise.all([
          scopePaths(agent.workspacePath, request.paths), scopePaths(agent.workspacePath, request.knowledgeBase), resolveCli(),
        ]);
        if (entry.stopReason) { entry.evidence.status = entry.stopReason; return { evidence: entry.evidence, artifactDirectory: null }; }
        if (!cli || !entry.grant.model || !entry.grant.effort || process.platform === 'win32') { entry.evidence.status = 'unavailable'; return { evidence: entry.evidence, artifactDirectory: null }; }
        directory = await mkdtemp(join(tempRoot, 'portos-security-'));
        await chmod(directory, 0o700);
        const outputDir = join(directory, 'results');
        const promptFile = join(directory, 'prompt.md');
        await writeFileGuarded(promptFile, request.prompt, { mode: 0o600 });
        await ensureDir(outputDir);
        const args = [...cli.args, 'scan', agent.workspacePath, '--mode', 'standard', '--auth', 'chatgpt', '--headless', '--json',
          '--model', entry.grant.model, '--effort', entry.grant.effort, '--max-cost', String(entry.grant.maxCostUsd),
          '--output-dir', outputDir, '--scan-prompt-file', promptFile,
          ...paths.flatMap(path => ['--path', path]), ...knowledgeBase.flatMap(path => ['--knowledge-base', path])];
        const env = Object.fromEntries(Object.entries(environment).filter(([key]) => ENV_KEYS.has(key)));
        env.CODEX_SECURITY_STATE_DIR = join(directory, 'state');
        env.PORTOS_SECURITY_SCAN_OWNER = randomUUID();
        entry.evidence.status = 'running';
        entry.evidence.cleanup = 'unconfirmed';
        await persist(id, entry);
        if (entry.stopReason) { entry.evidence.status = entry.stopReason; return { evidence: entry.evidence, artifactDirectory: directory }; }
        const detectRefusal = createContentRefusalDetector();
        let logTail = '';
        let logWrites = Promise.resolve();
        let logError;
        const logPath = join(directory, 'scan.log');
        const child = spawnProcess(process.execPath, [CHILD, outputDir], {
          cwd: agent.workspacePath, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        entry.child = child;
        entry.owner = { pid: child.pid, startedAt: Date.now(), marker: env.PORTOS_SECURITY_SCAN_OWNER, outputDir };
        // Private ownership receipt allows restart cleanup to verify identity,
        // including descendants whose group leader exited. Never signal by a
        // persisted PID alone.
        let resolveExit;
        let exitCleanup;
        const signal = signalName => kill(child, signalName, { processGroup: true });
        const cancel = () => {
          if (entry.cancelling) return;
          entry.cancelling = true;
          // Independent of the outer agent map and of child.killed. A wrapper
          // may exit before descendants; the process-group escalation survives.
          forceTimer = setTimeout(() => {
            exitCleanup = cleanupGroup(entry.owner).catch(() => false);
            // Do not wait forever for inherited pipes or a missing close event.
            exitCleanup.then(() => resolveExit({ code: null, failed: true }));
          }, graceMs);
          signal('SIGTERM');
        };
        entry.cancel = cancel;
        const consume = chunk => {
          const text = String(chunk);
          logTail = (logTail + text).slice(-65536);
          // The complete private log is an artifact; only bounded typed fields
          // are sent to PortOS or kept in the agent card.
          logWrites = logWrites.then(async () => {
            const { appendFileGuarded } = await import('../lib/fileCore.js');
            await appendFileGuarded(logPath, text, { mode: 0o600 });
          }).catch(err => { logError = err; entry.stopReason ||= 'interrupted'; cancel(); });
          const envelopes = [...logTail.split('\n'), logTail.slice(Math.max(0, logTail.lastIndexOf('\n{') + 1))];
          const structuredRefusal = envelopes.some(line => {
            let event; try { event = JSON.parse(line); } catch { return false; }
            const error = event.error || (event.type === 'event_msg' && event.payload?.type === 'task_complete' ? event.payload.error : null)
              || (event.method === 'turn/completed' ? event.params?.turn?.error : null);
            return error && isContentRefusalError({ message: typeof error === 'string' ? error : JSON.stringify(error) });
          });
          if ((detectRefusal(text) || structuredRefusal) && entry.stopReason !== 'refused') {
            entry.stopReason = 'refused';
            entry.evidence.status = 'refused';
            void persist(id, entry).catch(() => console.error(`❌ Scanner refusal receipt could not be saved for ${id}`));
            terminateRefusedOuter(id);
            cancel();
          }
        };
        child.stdout.on('data', consume);
        child.stderr.on('data', consume);
        const streamsEnded = Promise.all([child.stdout, child.stderr].map(stream =>
          new Promise(resolve => { stream.once('end', resolve); stream.once('close', resolve); })));
        const exitPromise = new Promise(resolve => {
          resolveExit = resolve;
          child.once('error', () => resolveExit({ code: null, failed: true }));
          child.once('exit', (code, signal) => {
            clearTimeout(deadline);
            exitCleanup = cleanupGroup(entry.owner).catch(() => false);
            // Exit can precede the last stderr refusal. Drain both streams,
            // bounded for a descendant holding inherited pipes open.
            drainTimer = setTimeout(() => resolveExit({ code, signal }), graceMs);
            Promise.all([streamsEnded, exitCleanup]).then(() => resolveExit({ code, signal }));
          });
          child.once('close', (code, signalName) => resolveExit({ code, signal: signalName }));
          deadline = setTimeout(() => { entry.stopReason ||= 'time-limit'; cancel(); }, entry.grant.timeLimitSeconds * 1000);
          if (entry.stopReason) cancel();
        });
        await atomicWrite(join(agentsDir, id, 'security-scan-process.json'), entry.owner);
        if (!entry.stopReason) {
          await new Promise((resolve, reject) => child.send({ command: cli.command, args }, err => err ? reject(err) : resolve()));
        }
        const exit = await exitPromise;
        clearTimeout(deadline);
        // Retire a still-owned group even on normal wrapper exit. Never leave
        // a scanner worker consuming quota after its CLI's completion.
        entry.evidence.cleanup = await (exitCleanup || cleanupGroup(entry.owner).catch(() => false)) ? 'confirmed' : 'unconfirmed';
        clearTimeout(forceTimer);
        entry.evidence.exitCode = exit.code ?? (exit.signal === 'SIGTERM' ? 143 : exit.signal === 'SIGKILL' ? 137 : null);
        entry.evidence.status = entry.stopReason || (exit.code === 0 && !exit.failed && entry.evidence.cleanup === 'confirmed' ? 'completed' : 'failed');
        const costs = [...logTail.matchAll(/short-context budget baseline:\s*\$([\d.]+)/g)];
        if (costs.length) entry.evidence.estimatedCostUsd = Number(costs.at(-1)[1]);
        if (!entry.stopReason && /(?:exceeds?|exceeded).*?(?:max.cost|budget)|budget.*?(?:exceeded|limit reached)/i.test(logTail)) entry.evidence.status = 'budget-limit';
        const files = await readdir(outputDir).catch(() => null);
        entry.evidence.artifacts = { findings: files?.includes('findings.json') ?? null, coverage: files?.includes('coverage.json') ?? null };
        await logWrites;
        if (logError) throw logError;
      } catch (err) {
        if (entry.child) {
          const confirmed = await cleanupGroup(entry.owner).catch(() => false);
          entry.evidence.cleanup = confirmed ? 'confirmed' : 'unconfirmed';
        }
        entry.evidence.status = entry.stopReason || 'unavailable';
        // No provider text, paths or credentials in shared logs.
        console.warn(`⚠️ Security scanner ${id} could not complete (${err.code || 'runtime-error'})`);
      } finally {
        clearTimeout(forceTimer);
        clearTimeout(deadline);
        clearTimeout(drainTimer);
        // Output may arrive during artifact/log persistence after process exit.
        if (entry.stopReason) entry.evidence.status = entry.stopReason;
        entry.child?.stdout.destroy();
        entry.child?.stderr.destroy();
        entry.child?.unref?.();
        entry.terminal = true;
        entry.cancel = null;
        try { await persist(id, entry); }
        finally {
          // A disk failure must never prevent stopping a refused outer request.
          if (entry.evidence.status === 'refused') terminateRefusedOuter(id);
        }
      }
      return { evidence: entry.evidence, artifactDirectory: directory || null };
    });
    return entry.promise;
  };
  // The delayed boot sweep must not stop a grant launched by this runner.
  const recover = id => getAgent(id) ? read(id) : stop(id);
  return { register, start, stop, read, recover };
}
