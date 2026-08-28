#!/usr/bin/env node
/**
 * `npm run doctor` — one read-only, pasteable report of every install
 * prerequisite (#5304).
 *
 * PortOS has a long prerequisite chain (Node/npm floors, an initialized
 * `lib/slashdo` submodule, four workspace `node_modules` trees, a reachable
 * Postgres with schema + pgvector, migrations applied, `data/` seeded from
 * `data.reference/`, pm2, the media toolchain, an optional TLS cert, `gh`
 * auth, the 5553–5561 port block) and until now the checks for it were
 * scattered across places that only run once something else is already
 * working: `checkNodeVersion.js`/`checkNpmVersion.js` fire inside
 * `npm run dev|start|setup`, `GET /api/system/health/details` needs the server
 * booted, `providerPrerequisites.js` covers only the AI CLIs, and
 * `smoke-boot.js` proves the process stays up but never says why it didn't.
 * When the server will not start there was no single thing to run.
 *
 * Three properties make this useful rather than just another status page:
 *
 * 1. **Read-only.** No installs, no migrations, no DB writes, no LLM calls
 *    (AGENTS.md "AI Provider Usage Policy"). Every probe is a SELECT, a stat,
 *    a `--version`, or a listen-and-close.
 * 2. **Loads from a bare checkout.** Its static imports are Node builtins and
 *    builtin-only repo modules, so it runs *before* `npm install` — the very
 *    state it most needs to describe. Anything with a third-party dependency
 *    (`pg`) is loaded with a dynamic `import()` inside its own probe, so a
 *    missing dependency becomes an `unavailable` fact instead of a stack
 *    trace. `scripts/pre-install-entrypoints.test.js` enforces this.
 * 3. **Pasteable.** Details name no hostnames, usernames, IPs, home-directory
 *    paths, or DB passwords: paths are repo-relative or scrubbed through
 *    `scrubHomePath`, and Postgres is reported by host-class (`system :5432` /
 *    `docker :5561`) rather than by connection string.
 *
 * Every fact is independent and separately bounded, so one hung probe degrades
 * to a single `unavailable` line instead of hanging the report.
 *
 * Usage:
 *   npm run doctor            # human-readable table
 *   npm run doctor -- --json  # { ok, facts: [{ name, status, detail, required }] }
 * Exits 1 when any REQUIRED fact is unavailable, 0 otherwise.
 */

import { existsSync } from 'fs';
import { readdir } from 'fs/promises';
import { createRequire } from 'module';
import { createServer } from 'net';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { certPaths } from '../lib/certPaths.js';
import { commandExists } from '../server/lib/commandExists.js';
import { scrubHomePath } from '../server/lib/homePath.js';
import { MIN_NODE, compareVersions, satisfiesMinNode } from './checkNodeVersion.js';
import { MIN_NPM, parseNpmUserAgent, readBundledNpmVersion } from './checkNpmVersion.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import { listPendingMigrations } from './run-migrations.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Per-probe bound. Generous enough for a cold Postgres connection (db.js allows
 * 10s to establish one) while still capping the whole report — the probes run
 * concurrently, so this is roughly the report's own ceiling, not a per-fact
 * tax.
 */
export const PROBE_TIMEOUT_MS = 12_000;

/** Shorter bound for the cheap local probes (stat, listen, `--version`). */
const FAST_TIMEOUT_MS = 6_000;

/** The workspaces `scripts/ensure-deps.js` installs — each needs node_modules. */
const WORKSPACES = ['', 'client', 'server', 'autofixer'];

/**
 * The PortOS-owned port block from `ecosystem.config.cjs` (docs/PORTS.md).
 * Anything outside it in `PORTS` belongs to something the operator starts by
 * hand (whisper, llama.cpp, the vLLM/SGLang containers) and is none of a fresh
 * install's business.
 */
const PORT_BLOCK = { min: 5553, max: 5561 };

/**
 * Read `PORTS` out of the CJS ecosystem config. Isolated (and defensive) so a
 * malformed `.env` or a config the caller has edited degrades to "couldn't read
 * the port list" rather than taking the whole report down.
 * @returns {number[]} sorted, deduped ports inside the PortOS block
 */
export function portBlock(root = ROOT) {
  const require = createRequire(import.meta.url);
  const { PORTS } = require(join(root, 'ecosystem.config.cjs'));
  const inBlock = Object.values(PORTS)
    .filter((p) => Number.isInteger(p) && p >= PORT_BLOCK.min && p <= PORT_BLOCK.max);
  return [...new Set(inBlock)].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Probe runner
// ---------------------------------------------------------------------------

/**
 * Run one probe into a fact, bounded and total.
 *
 * A probe reports `{ available, detail }`. It may also throw or hang: both
 * become an `unavailable` fact carrying the reason, because a doctor that
 * crashes on the first broken prerequisite is a doctor that can't diagnose a
 * broken install. Details are scrubbed on the way out so a thrown ENOENT
 * (which embeds an absolute path) can't leak a username into the report.
 *
 * @param {{name: string, required?: boolean, timeoutMs?: number, run: function}} probe
 * @returns {Promise<{name: string, status: 'available'|'unavailable', detail: string, required: boolean}>}
 */
export async function runProbe(probe) {
  const required = probe.required !== false;
  const timeoutMs = probe.timeoutMs ?? PROBE_TIMEOUT_MS;

  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ available: false, detail: `probe timed out after ${timeoutMs}ms` }), timeoutMs);
    // Never hold the event loop open on the timer itself — if every probe has
    // settled, the report should print immediately.
    timer.unref?.();
  });

  const result = await Promise.race([
    Promise.resolve()
      .then(() => probe.run())
      .catch((err) => ({ available: false, detail: `probe failed: ${err?.message || err}` })),
    timeout,
  ]);
  clearTimeout(timer);

  return {
    name: probe.name,
    status: result?.available ? 'available' : 'unavailable',
    detail: scrubHomePath(String(result?.detail ?? '')),
    required,
  };
}

/**
 * Run every probe concurrently. Order of the returned facts follows the probe
 * list, not completion order, so two runs of the same install produce a
 * byte-identical report and a user can diff them.
 */
export async function collectFacts(probes) {
  return Promise.all(probes.map((probe) => runProbe(probe)));
}

/**
 * `ok` is true only when every REQUIRED fact is available. Optional facts (the
 * cert, `gh`, the media toolchain, the port block) are reported but never fail
 * the run — none of them stops PortOS from booting.
 */
export function summarize(facts) {
  return { ok: facts.every((f) => !f.required || f.status === 'available'), facts };
}

/** Human-readable table. Aligned on the longest name so it scans vertically. */
export function formatReport({ ok, facts }) {
  const width = facts.reduce((max, f) => Math.max(max, f.name.length), 0);
  const lines = facts.map((f) => {
    const icon = f.status === 'available' ? '✅' : f.required ? '❌' : '⚠️ ';
    return `${icon} ${f.name.padEnd(width)}  ${f.detail}`;
  });
  const missing = facts.filter((f) => f.required && f.status === 'unavailable');
  lines.push('');
  lines.push(ok
    ? '✅ All required prerequisites are available'
    : `❌ ${missing.length} required prerequisite${missing.length === 1 ? '' : 's'} unavailable: ${missing.map((f) => f.name).join(', ')}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

/** `existsSync` on a repo-relative path — detail names the path, never the root. */
function probePath(root, relativePath, { presentDetail, missingDetail }) {
  const available = existsSync(join(root, relativePath));
  return { available, detail: available ? presentDetail : missingDetail };
}

async function probeNode() {
  const version = process.versions.node;
  return satisfiesMinNode(version)
    ? { available: true, detail: `v${version} (floor ${MIN_NODE})` }
    : { available: false, detail: `v${version} is below the ${MIN_NODE} floor — see .nvmrc` };
}

/**
 * npm is ADVISORY, never required: no Node release bundles npm 12 yet, so an
 * older npm is a correct install that merely churns the lockfiles. Same
 * reasoning as `checkNpmVersion.js`, which warns rather than exits.
 */
async function probeNpm() {
  const version = parseNpmUserAgent();
  if (!version) {
    const bundled = readBundledNpmVersion();
    return bundled
      ? { available: true, detail: `not running under npm; Node bundles npm ${bundled}` }
      : { available: true, detail: 'not running under npm' };
  }
  return compareVersions(version, MIN_NPM) >= 0
    ? { available: true, detail: `${version}` }
    : { available: false, detail: `${version} is below ${MIN_NPM} — installs rewrite package-lock.json (npm install -g npm@latest)` };
}

async function probeSubmodule(root) {
  return probePath(root, join('lib', 'slashdo', 'package.json'), {
    presentDetail: 'lib/slashdo checked out',
    missingDetail: 'lib/slashdo is empty — run: git submodule update --init --recursive',
  });
}

async function probeWorkspaceDeps(root, workspace) {
  const relative = workspace ? join(workspace, 'node_modules') : 'node_modules';
  return probePath(root, relative, {
    presentDetail: `${relative.replace(/\\/g, '/')} present`,
    missingDetail: `${relative.replace(/\\/g, '/')} missing — run: npm run install:all`,
  });
}

/**
 * `scripts/setup-data.js` copies every top-level `data.reference/` entry into
 * `data/`, so a missing entry means setup never ran (or ran before that entry
 * shipped). Names come from the repo, never from the user's records, so they
 * are safe to print.
 */
async function probeDataSeeded(root) {
  const reference = join(root, 'data.reference');
  if (!existsSync(reference)) return { available: false, detail: 'data.reference/ missing — incomplete checkout' };
  const entries = await readdir(reference);
  const missing = entries.filter((entry) => !existsSync(join(root, 'data', entry)));
  return missing.length === 0
    ? { available: true, detail: `data/ seeded (${entries.length} reference entries)` }
    : { available: false, detail: `${missing.length}/${entries.length} entries missing (${missing.slice(0, 5).join(', ')}) — run: npm run setup:data` };
}

/**
 * The Postgres connection, reported by HOST CLASS only.
 *
 * `db.js` opens a pool on import and pulls in `pg`, so it is loaded lazily:
 * that keeps doctor runnable before `npm install`, and it means an install
 * with no dependencies reports "unavailable" here rather than failing to
 * start. The pool is memoized across the two DB probes and closed once, in
 * `runDoctor`, so a single connection serves both and the process still exits.
 */
let dbStatePromise = null;
function loadDbState() {
  dbStatePromise ??= (async () => {
    // A checkout with no `server/node_modules` cannot resolve `pg`. That is a
    // dependency fact the deps: probes already report, so translate it here
    // rather than surfacing a module-resolution stack trace as if the database
    // itself were broken.
    const db = await import('../server/lib/db.js').catch((err) => {
      if (err?.code === 'ERR_MODULE_NOT_FOUND') return null;
      throw err;
    });
    if (!db) return { db: null, health: { connected: false, hasSchema: false }, vector: false, depsMissing: true };
    const health = await db.checkHealth();
    // Only ask about pgvector once we know the connection works — otherwise the
    // extension probe would just re-report the same connection failure.
    const vector = health.connected
      ? await db.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'").then((r) => r.rowCount > 0).catch(() => false)
      : false;
    return { db, health, vector, depsMissing: false };
  })();
  return dbStatePromise;
}

/** `system :5432` / `docker :5561` — never a host, user, or password. */
function pgHostClass() {
  const port = parseInt(process.env.PGPORT || '5432', 10);
  return `${port === 5561 ? 'docker' : 'system'} :${port}`;
}

async function probePostgres() {
  const { health, depsMissing } = await loadDbState();
  if (depsMissing) return { available: false, detail: 'not checked — server dependencies missing; run: npm run install:all' };
  if (!health.connected) return { available: false, detail: `unreachable on ${pgHostClass()} — run: npm run setup:db` };
  if (!health.hasSchema) return { available: false, detail: `connected on ${pgHostClass()} but schema is missing — run: npm run setup:db` };
  return { available: true, detail: `connected on ${pgHostClass()}, schema present` };
}

async function probePgvector() {
  const { health, vector, depsMissing } = await loadDbState();
  if (depsMissing) return { available: false, detail: 'not checked — server dependencies missing; run: npm run install:all' };
  if (!health.connected) return { available: false, detail: 'not checked — database unreachable' };
  return vector
    ? { available: true, detail: 'extension installed' }
    : { available: false, detail: 'extension missing — the creative catalog needs pgvector; run: npm run setup:db' };
}

/**
 * Reads `data/migrations.applied.json` only — `listPendingMigrations` is the
 * documented pure-read half of the migration runner and never applies anything.
 */
async function probeMigrations(root) {
  const pending = await listPendingMigrations({
    rootDir: root,
    migrationsDir: join(root, 'scripts', 'migrations'),
  });
  return pending.length === 0
    ? { available: true, detail: 'all migrations applied' }
    : { available: false, detail: `${pending.length} pending (${pending.slice(0, 3).join(', ')}) — run: npm run migrations` };
}

/**
 * A capability probe, not a PATH lookup: `commandExists` actually invokes the
 * binary, so a broken shim on PATH reports unavailable.
 */
async function probeCommand(cmd, args, { presentDetail, missingDetail }) {
  const available = await commandExists(cmd, args, { timeoutMs: FAST_TIMEOUT_MS });
  return { available, detail: available ? presentDetail : missingDetail };
}

async function probeCert(root) {
  const { cert, key } = certPaths(join(root, 'data'));
  const available = existsSync(cert) && existsSync(key);
  return {
    available,
    detail: available
      ? 'data/certs/{cert,key}.pem present — server boots HTTPS on :5555'
      : 'no cert — server boots HTTP (optional; run: npm run setup:cert)',
  };
}

/** Can we bind this port on loopback? Closes immediately either way. */
export function isPortFree(port, { timeoutMs = FAST_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const server = createServer();
    const settle = (free) => {
      server.removeAllListeners();
      server.close(() => resolve(free));
    };
    const guard = setTimeout(() => settle(false), timeoutMs);
    guard.unref?.();
    server.once('error', () => { clearTimeout(guard); settle(false); });
    server.once('listening', () => { clearTimeout(guard); settle(true); });
    server.listen(port, '127.0.0.1');
  });
}

/**
 * OPTIONAL, deliberately. A healthy install that is currently RUNNING occupies
 * most of this block, so failing the report on an occupied port would make
 * `npm run doctor` exit non-zero on every working machine — the opposite of
 * the signal it exists to give. Occupancy is reported as a fact for the case it
 * actually diagnoses (a foreign process squatting on :5555 before PortOS
 * starts) and left for the reader to interpret.
 */
async function probePorts(root) {
  const ports = portBlock(root);
  // Concurrently: serialized, nine ports at the per-port bound could outlast
  // this probe's own budget and report a timeout instead of the occupancy.
  const free = await Promise.all(ports.map((port) => isPortFree(port)));
  const taken = ports.filter((_, i) => !free[i]);
  return taken.length === 0
    ? { available: true, detail: `${ports.length} ports free (${PORT_BLOCK.min}–${PORT_BLOCK.max})` }
    : { available: false, detail: `in use: ${taken.join(', ')} — expected when PortOS is already running` };
}

/**
 * The full prerequisite list, in report order: toolchain, then checkout, then
 * data, then services, then the optional extras.
 * @returns {Array<{name: string, required: boolean, run: function}>}
 */
export function defaultProbes({ root = ROOT } = {}) {
  return [
    { name: 'node', required: true, run: probeNode },
    { name: 'npm', required: false, run: probeNpm },
    { name: 'submodule:slashdo', required: true, run: () => probeSubmodule(root) },
    ...WORKSPACES.map((workspace) => ({
      name: `deps:${workspace || 'root'}`,
      required: true,
      run: () => probeWorkspaceDeps(root, workspace),
    })),
    { name: 'data:seeded', required: true, run: () => probeDataSeeded(root) },
    { name: 'postgres', required: true, run: probePostgres },
    { name: 'postgres:pgvector', required: true, run: probePgvector },
    { name: 'migrations', required: true, run: () => probeMigrations(root) },
    {
      name: 'pm2',
      required: true,
      run: () => probeCommand('pm2', ['--version'], {
        presentDetail: 'available — npm start manages apps through it',
        missingDetail: 'not runnable — run: npm run install:all',
      }),
    },
    {
      name: 'ffmpeg',
      required: false,
      run: () => probeCommand('ffmpeg', ['-version'], {
        presentDetail: 'available',
        missingDetail: 'not runnable — media transcode/thumbnail jobs will fail',
      }),
    },
    {
      name: 'python3',
      required: false,
      run: () => probeCommand('python3', ['--version'], {
        presentDetail: 'available',
        missingDetail: 'not runnable — local image/audio/video generators will fail',
      }),
    },
    {
      name: 'uv',
      required: false,
      run: () => probeCommand('uv', ['--version'], {
        presentDetail: 'available',
        missingDetail: 'not runnable — the Python generators resolve their envs with it',
      }),
    },
    {
      name: 'gh',
      required: false,
      run: () => probeCommand('gh', ['auth', 'status'], {
        presentDetail: 'authenticated',
        missingDetail: 'not installed or not authenticated — run: gh auth login',
      }),
    },
    { name: 'tls-cert', required: false, run: () => probeCert(root) },
    { name: 'ports', required: false, run: () => probePorts(root) },
  ];
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * Collect, format, and report. Injectable end to end so the test exercises the
 * real assembly without spawning a second interpreter or touching a database.
 *
 * @returns {Promise<{ok: boolean, facts: object[], exitCode: number}>}
 */
export async function runDoctor({ probes = defaultProbes(), json = false, log = console.log } = {}) {
  const report = summarize(await collectFacts(probes));
  log(json ? JSON.stringify(report, null, 2) : formatReport(report));
  return { ...report, exitCode: report.ok ? 0 : 1 };
}

/**
 * Close anything a probe opened (today: the `pg` pool the database probes
 * share), so the process exits on its own. Exported because a programmatic
 * caller running `defaultProbes()` inherits the same open pool.
 */
export async function closeProbeResources() {
  if (!dbStatePromise) return;
  await dbStatePromise.then(({ db }) => db?.close()).catch(() => {});
  dbStatePromise = null;
}

// Runnable directly: `node scripts/doctor.js [--json]` — see
// lib/directInvocation.js for why this is not a plain string equality.
if (isDirectlyInvoked(import.meta.url)) {
  const { exitCode } = await runDoctor({ json: process.argv.includes('--json') });
  await closeProbeResources();
  process.exitCode = exitCode;
}
