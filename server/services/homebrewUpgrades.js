/**
 * Homebrew upgrade manager for Settings › Software (macOS). Lists outdated formulae
 * and casks with the risk each upgrade carries for what PortOS runs on
 * (`lib/homebrewUpgradeRisk.js`), runs the upgrades the owner picks with progress on
 * `software:homebrew`, and afterwards checks and repairs the usual fallout: a
 * Postgres extension library the upgrade removed (repaired by `scripts/setup-db.js`,
 * which owns rebuilding it), a database that needs a restart, an ffmpeg that no
 * longer starts, and a pyenv Python whose linked Homebrew library changed.
 *
 * Risk and busy warnings never block the owner: each answers 409 with what it
 * found and the request goes ahead with `acknowledgeRisk` / `acknowledgeBusy`.
 * The same check-and-repair runs on its own for an upgrade made in a terminal.
 */
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from '../lib/childProcess.js';
import { ServerError } from '../lib/errorHandler.js';
import { homebrewPackageFor } from '../lib/homebrewPackage.js';
import { classifyHomebrewOutdated, postgresFormulaFor } from '../lib/homebrewUpgradeRisk.js';
import { PATHS } from '../lib/paths.js';
import { findCommandOnPath, safeChildProcessOptions, withoutServerSecretsEnv } from '../lib/processEnv.js';
import { runStreamingCommand } from '../lib/streamingSpawn.js';
import { trackedRenderMap } from './renderActivity.js';

const runFile = promisify(execFile);
export const HOMEBREW_PROGRESS_EVENT = 'software:homebrew';
const STATUS_TTL_MS = 5 * 60 * 1000;
const READ_TIMEOUT_MS = 60_000;
const UPDATE_TIMEOUT_MS = 3 * 60 * 1000;
const UPGRADE_TIMEOUT_MS = 30 * 60 * 1000;
const REBUILD_TIMEOUT_MS = 45 * 60 * 1000;
const DB_WAIT_MS = 60_000;
const BREW_CANDIDATES = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'];
// The cast makes the server load the extension library, so an installed extension
// whose library an upgrade removed fails here rather than in a user's request.
const VECTOR_PROBE_SQL = "SELECT '[1]'::vector AS v";
// Modules whose extension libraries Homebrew supplies (OpenSSL, libffi, SQLite).
const PYTHON_PROBE = 'import ssl, ctypes, sqlite3';

let statusCache = null; // { at, value }
let currentJob = null;
// A PortOS update would kill brew mid-upgrade and leave a formula unlinked.
const liveRuns = trackedRenderMap('homebrew', { noun: 'Homebrew job', link: () => '/settings/software' });
let lastRun = null;

// The database setup authenticates as PortOS does, so it keeps the connection settings.
const DB_ENV_KEYS = ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGMODE', 'PORTOS_NATIVE_PGPORT'];
const pick = (env, keys) => Object.fromEntries(keys.filter((key) => env[key] !== undefined).map((key) => [key, env[key]]));
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const home = homedir();
/** Paths shown in the UI drop the account's home directory. */
const tildify = (path) => (path && path.startsWith(home) ? `~${path.slice(home.length)}` : path);
const realpathOr = (path) => { try { return realpathSync(path); } catch { return path; } };

export function findBrew({ platform = process.platform, env = process.env, exists = existsSync } = {}) {
  if (platform !== 'darwin') return null;
  return findCommandOnPath('brew', { env }) || BREW_CANDIDATES.find((path) => exists(path)) || null;
}

// Homebrew must not auto-update in the middle of an upgrade: what runs has to be
// what the owner was shown. Colors and hints only clutter the streamed progress.
const brewEnv = () => ({
  ...withoutServerSecretsEnv(process.env),
  HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ENV_HINTS: '1', HOMEBREW_NO_COLOR: '1', NO_COLOR: '1',
});

async function readJson(brew, args) {
  const { stdout } = await runFile(brew, args, safeChildProcessOptions({ env: brewEnv(), timeout: READ_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }));
  return JSON.parse(stdout);
}

async function defaultQuery(sql) {
  const { query } = await import('../lib/db.js');
  return query(sql);
}

/** Every Python interpreter PortOS runs, deduplicated by real path, with a label for the UI. */
async function portosPythons() {
  const setup = await import('../lib/pythonSetup.js');
  const { resolveCondaEnvPython } = await import('../lib/condaEnv.js');
  const candidates = [
    setup.detectPythonSync(),
    ...setup.NUMPY_PYTHON_RESOLVERS.map((resolve) => resolve()),
    setup.resolveMuscriptorPython(),
    resolveCondaEnvPython('rigging'),
  ].filter((path) => path && existsSync(path));
  const seen = new Map();
  for (const path of candidates) {
    const real = realpathOr(path);
    if (!seen.has(real)) seen.set(real, { path, real });
  }
  return [...seen.values()].map(({ path, real }) => {
    const pyenv = real.match(/\/\.pyenv\/versions\/([^/]+)\//);
    return { path, real, pyenvVersion: pyenv?.[1] || null, label: pyenv ? `pyenv Python ${pyenv[1]}` : `Python at ${tildify(path)}` };
  });
}

/**
 * The Homebrew formulae a Python built outside Homebrew links, read with `otool -L`
 * from the interpreter and its extension modules (where pyenv builds link
 * OpenSSL, gettext, readline, xz).
 */
async function linkedFormulae(python, { run = runFile } = {}) {
  const prefix = dirname(dirname(python.real));
  const dynload = readdirSync(join(prefix, 'lib'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^python\d/.test(entry.name))
    .map((entry) => join(prefix, 'lib', entry.name, 'lib-dynload'))
    .filter((dir) => existsSync(dir));
  const files = [python.real, ...dynload.flatMap((dir) => readdirSync(dir).filter((name) => name.endsWith('.so')).map((name) => join(dir, name)))];
  const { stdout } = await run('/usr/bin/otool', ['-L', ...files], safeChildProcessOptions({ timeout: READ_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }));
  // Anchored at the Homebrew prefix (Apple Silicon or Intel), so the `/opt/` in
  // `/opt/homebrew/` itself is never read as a formula name.
  const names = [...String(stdout).matchAll(/(?:\/opt\/homebrew|\/usr\/local)\/(?:opt|Cellar)\/([\w.+@-]+)\/\S*\.dylib/g)].map((match) => match[1]);
  return [...new Set(names)];
}

/** What PortOS runs that a Homebrew upgrade can affect, for the risk rules. */
async function readUses({ readPostgres, pythons }) {
  const postgres = await readPostgres().catch(() => null);
  const ffmpeg = findCommandOnPath('ffmpeg');
  const linkedBy = {};
  const pythonFormulas = [];
  for (const python of pythons) {
    const owner = homebrewPackageFor(python.real);
    if (owner) { pythonFormulas.push(owner.name); continue; }
    const formulas = await linkedFormulae(python).catch(() => []);
    for (const formula of formulas) (linkedBy[formula] ||= []).push(python.label);
  }
  return {
    postgres,
    uses: {
      postgresFormula: postgresFormulaFor(postgres),
      nodeFormula: homebrewPackageFor(process.execPath)?.name || null,
      ffmpegFormula: ffmpeg ? homebrewPackageFor(ffmpeg)?.name || null : null,
      pythonFormulas: [...new Set(pythonFormulas)],
      linkedBy,
    },
  };
}

async function readPostgresStatus() {
  return (await import('./postgresRuntime.js')).getPostgresRuntimeStatus();
}

async function probeVector(query) {
  return query(VECTOR_PROBE_SQL).then(() => ({ ok: true }), (error) => ({ ok: false, detail: error.cause?.message || error.message }));
}

async function probePython(python, run = runFile) {
  return run(python.path, ['-c', PYTHON_PROBE], safeChildProcessOptions({ timeout: 30_000 }))
    .then(() => ({ ok: true }), (error) => ({ ok: false, detail: String(error.stderr || error.message).trim().split('\n').slice(-2).join(' ').slice(0, 300) }));
}

/** Problems visible now, without changing anything: the page offers Repair for these. */
async function readProblems({ query, pythons, postgres }) {
  const problems = [];
  const vector = await probeVector(query);
  if (!vector.ok && !/type "vector" does not exist/.test(vector.detail || '')) {
    problems.push({ id: 'postgres-extensions', label: 'pgvector does not load in PortOS\'s database', detail: vector.detail,
      repair: postgres?.mode === 'native' ? 'Repair runs the database setup, which rebuilds pgvector for this PostgreSQL.' : 'Repair runs the database setup.' });
  }
  for (const python of pythons) {
    const result = await probePython(python);
    if (!result.ok) {
      problems.push({ id: `python:${python.real}`, label: `${python.label} does not start`, detail: result.detail,
        repair: python.pyenvVersion ? `Repair rebuilds it with \`pyenv install --force ${python.pyenvVersion}\`.` : 'Recreate this environment from a working Python.' });
    }
  }
  return problems;
}

/**
 * @param {{fresh?: boolean, deps?: object}} [options] `fresh` runs `brew update` first,
 * so the list reflects what Homebrew has published now.
 */
export async function getHomebrewStatus({ fresh = false, deps = {} } = {}) {
  const {
    platform = process.platform, now = Date.now, query = defaultQuery, readPostgres = readPostgresStatus,
    listPythons = portosPythons, read = readJson, stream = runStreamingCommand,
  } = deps;
  const brew = deps.brew === undefined ? findBrew({ platform }) : deps.brew;
  if (platform !== 'darwin') return { supported: false, reason: 'The Homebrew upgrade manager runs on macOS.', job: null, lastRun: null };
  if (!brew) return { supported: false, reason: 'Homebrew is not installed.', job: null, lastRun: null };
  if (!fresh && statusCache && now() - statusCache.at < STATUS_TTL_MS) return { ...statusCache.value, job: currentJob, lastRun };

  if (fresh) {
    const update = await stream(brew, ['update', '--quiet'], null, { timeoutMs: UPDATE_TIMEOUT_MS, env: brewEnv() });
    if (!update.success) console.log(`⏭️ brew update failed; listing from the local tap state: ${update.error}`);
  }
  const outdated = await read(brew, ['outdated', '--json=v2']);
  const formulaNames = (outdated.formulae || []).map((pkg) => pkg.name);
  const infos = formulaNames.length ? (await read(brew, ['info', '--json=v2', '--formula', ...formulaNames])).formulae || [] : [];
  const pythons = await listPythons().catch(() => []);
  const { postgres, uses } = await readUses({ readPostgres, pythons });
  const packages = classifyHomebrewOutdated(outdated, infos, uses);
  const problems = await readProblems({ query, pythons, postgres });
  const value = { supported: true, packages, problems, postgresFormula: uses.postgresFormula, checkedAt: new Date(now()).toISOString() };
  statusCache = { at: now(), value };
  return { ...value, job: currentJob, lastRun };
}

/** Wait until the database answers again after a restart. */
async function waitForDatabase(query, { timeoutMs = DB_WAIT_MS, pause = sleep } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await query('SELECT 1').then(() => true, () => false)) return true;
    await pause(1_000);
  }
  return false;
}

/**
 * Check what an upgrade usually breaks and repair what can be repaired. Returns one
 * result per check; a failed repair is reported, never thrown, so the others run.
 */
async function checkAndRepair({ emit, brew, query, upgraded = [], run, listPythons, readPostgres, checkHealth, probe = runFile, pyenv: pyenvPath }) {
  const results = [];
  const record = (id, label, ok, detail = null, repaired = false) => {
    results.push({ id, label, ok, detail, repaired });
    emit('check', ok ? 'done' : 'error', `${label}: ${ok ? (repaired ? 'repaired' : 'ok') : detail || 'failed'}`);
  };
  const postgres = await readPostgres().catch(() => null);
  const postgresFormula = postgresFormulaFor(postgres);

  // The database keeps running the old binaries until it restarts.
  if (postgresFormula && upgraded.includes(postgresFormula)) {
    await run(brew, ['services', 'restart', postgresFormula], `Restarting ${postgresFormula}…`, UPGRADE_TIMEOUT_MS);
    if (!(await waitForDatabase(query))) record('postgres', 'Database', false, `${postgresFormula} did not come back within ${DB_WAIT_MS / 1000}s.`);
  }

  let vector = await probeVector(query);
  if (!vector.ok && !/type "vector" does not exist/.test(vector.detail || '')) {
    emit('check', 'running', `pgvector does not load (${vector.detail}); running the database setup…`);
    // setup-db's readiness probe loads the library, so a missing build sends it
    // through the native setup that rebuilds pgvector for this PostgreSQL major.
    const setup = await run(process.execPath, [join(PATHS.root, 'scripts', 'setup-db.js')], 'Running database setup…', REBUILD_TIMEOUT_MS,
      { cwd: PATHS.root, env: { ...brewEnv(), ...pick(process.env, DB_ENV_KEYS) } });
    vector = setup.success ? await probeVector(query) : { ok: false, detail: setup.error };
    record('postgres-extensions', 'pgvector', vector.ok, vector.ok ? null : `${vector.detail}. Run \`npm run setup:db\` in a terminal to see the full output.`, vector.ok);
  } else {
    record('postgres-extensions', 'pgvector', true);
  }

  const ffmpeg = findCommandOnPath('ffmpeg');
  if (ffmpeg) {
    let ok = (await run(ffmpeg, ['-version'], null, READ_TIMEOUT_MS)).success;
    const owner = homebrewPackageFor(ffmpeg);
    let repaired = false;
    if (!ok && owner?.kind === 'formula') {
      await run(brew, ['reinstall', owner.name], `ffmpeg does not start; reinstalling ${owner.name}…`, UPGRADE_TIMEOUT_MS);
      ok = (await run(ffmpeg, ['-version'], null, READ_TIMEOUT_MS)).success;
      repaired = ok;
    }
    record('ffmpeg', 'ffmpeg', ok, ok ? null : `${tildify(ffmpeg)} does not start.`, repaired);
  }

  if (homebrewPackageFor(process.execPath)) {
    const ok = (await run(process.execPath, ['--version'], null, READ_TIMEOUT_MS)).success;
    record('node', 'Node.js PortOS runs on', ok, ok ? null : 'Homebrew\'s Node no longer starts; PortOS keeps running until its next restart. Switch PortOS to an nvm Node on PortOS update.');
  }

  const pyenv = pyenvPath !== undefined ? pyenvPath : findCommandOnPath('pyenv') || [join(home, '.pyenv', 'bin', 'pyenv')].find((path) => existsSync(path)) || null;
  for (const python of await listPythons().catch(() => [])) {
    let result = await probePython(python, probe);
    let repaired = false;
    if (!result.ok && python.pyenvVersion && pyenv) {
      // Rebuilding at the same version keeps every venv created from it working.
      const rebuilt = await run(pyenv, ['install', '--force', python.pyenvVersion], `${python.label} does not start; rebuilding it against the upgraded libraries…`, REBUILD_TIMEOUT_MS);
      if (rebuilt.success) { result = await probePython(python, probe); repaired = result.ok; }
    }
    record(`python:${python.real}`, python.label, result.ok, result.ok ? null
      : python.pyenvVersion ? `${result.detail}. Rebuild with \`pyenv install --force ${python.pyenvVersion}\`.` : `${result.detail}. Recreate this environment.`, repaired);
  }

  const health = await checkHealth();
  record('database', 'PortOS database', health.connected && health.hasSchema, health.error || (health.hasSchema ? null : 'schema missing'));
  return results;
}

const busyError = () => new ServerError('A Homebrew job is already running.', { status: 409, code: 'HOMEBREW_BUSY' });

function assertSupported(platform, brew) {
  if (platform !== 'darwin') throw new ServerError('The Homebrew upgrade manager runs on macOS.', { status: 409, code: 'HOMEBREW_UNSUPPORTED' });
  if (!brew) throw new ServerError('Homebrew is not installed.', { status: 409, code: 'HOMEBREW_MISSING' });
}

/**
 * Start a background job: `upgrade` upgrades `names` and then checks and repairs,
 * `repair` only checks and repairs. Answers `{ started: true }`; progress streams on
 * `software:homebrew` and `software:changed { reason: 'homebrew' }` ends it.
 */
export async function startHomebrewJob({ kind, names = [], acknowledgeRisk = false, acknowledgeBusy = false, io, deps = {} }) {
  const {
    platform = process.platform, query = defaultQuery, readPostgres = readPostgresStatus, listPythons = portosPythons,
    assertIdle = (await import('./nodeRuntime.js')).assertIdleUnlessAcknowledged,
    checkHealth = async () => (await import('../lib/db.js')).checkHealth(),
    stream = runStreamingCommand, probe = runFile, readStatus = getHomebrewStatus,
  } = deps;
  const brew = deps.brew === undefined ? findBrew({ platform }) : deps.brew;
  assertSupported(platform, brew);
  if (currentJob) throw busyError();

  let selected = [];
  if (kind === 'upgrade') {
    const status = await readStatus({ deps });
    const byName = new Map((status.packages || []).map((pkg) => [pkg.name, pkg]));
    const unknown = names.filter((name) => !byName.has(name));
    if (unknown.length) throw new ServerError(`Not outdated: ${unknown.join(', ')}. Check again and retry.`, { status: 400, code: 'HOMEBREW_NOT_OUTDATED' });
    selected = names.map((name) => byName.get(name));
    const pinned = selected.filter((pkg) => pkg.risk === 'pinned');
    if (pinned.length) throw new ServerError(`Held: ${pinned.map((pkg) => pkg.name).join(', ')}. Release them first.`, { status: 409, code: 'HOMEBREW_PINNED' });
    const breaking = selected.filter((pkg) => pkg.risk === 'breaking');
    if (breaking.length && !acknowledgeRisk) {
      throw new ServerError(breaking.map((pkg) => `${pkg.name}: ${pkg.reasons[0]}`).join(' '), { status: 409, code: 'HOMEBREW_UPGRADE_RISK' });
    }
  }
  await assertIdle({ acknowledgeBusy, action: 'Homebrew upgrades and repairs can restart the database and tools PortOS is using' });
  if (currentJob) throw busyError();

  const emit = (step, status, message, name = null) => io?.emit(HOMEBREW_PROGRESS_EVENT, { step, status, message, name, kind });
  const run = async (cmd, args, label, timeoutMs, options = {}) => {
    if (label) emit('run', 'running', label);
    let last = '';
    const result = await stream(cmd, args, (line) => {
      const text = String(line).trim();
      if (!text || text === last) return;
      last = text;
      emit('run', 'running', text.slice(0, 200));
    }, { timeoutMs, env: brewEnv(), ...options });
    if (!result.success && label) emit('run', 'error', `${label.replace(/…$/, '')} failed: ${result.error || 'unknown error'}`);
    return result;
  };

  currentJob = { kind, names: selected.map((pkg) => pkg.name), startedAt: new Date().toISOString() };
  liveRuns.set('brew', kind);
  Promise.resolve().then(async () => {
    const upgraded = [];
    const failed = [];
    let results = [];
    try {
      for (const pkg of selected) {
        currentJob = { ...currentJob, current: pkg.name };
        emit('upgrade', 'running', `Upgrading ${pkg.name} ${pkg.installed} → ${pkg.current}…`, pkg.name);
        const args = pkg.kind === 'cask' ? ['upgrade', '--cask', pkg.name] : ['upgrade', '--formula', pkg.name];
        const result = await run(brew, args, null, UPGRADE_TIMEOUT_MS);
        if (result.success) { upgraded.push(pkg.name); emit('upgrade', 'done', `${pkg.name} upgraded to ${pkg.current}`, pkg.name); }
        else { failed.push(pkg.name); emit('upgrade', 'error', `${pkg.name} did not upgrade: ${result.error}`, pkg.name); }
      }
      currentJob = { ...currentJob, current: null };
      emit('check', 'running', 'Checking what PortOS runs on…');
      results = await checkAndRepair({ emit, brew, query, upgraded, run, listPythons, readPostgres, checkHealth, probe, pyenv: deps.pyenv });
      const broken = results.filter((result) => !result.ok);
      const summary = [
        upgraded.length && `Upgraded ${upgraded.length}`,
        failed.length && `${failed.length} failed (${failed.join(', ')})`,
        broken.length ? `still broken: ${broken.map((result) => result.label).join(', ')}` : 'all checks pass',
      ].filter(Boolean).join('; ');
      emit(broken.length || failed.length ? 'error' : 'complete', broken.length || failed.length ? 'error' : 'done', summary);
      console.log(`🍺 Homebrew ${kind}: ${summary}`);
    } catch (error) {
      console.error(`❌ Homebrew ${kind} failed: ${error.message}`);
      emit('error', 'error', error.message);
    } finally {
      lastRun = { kind, finishedAt: new Date().toISOString(), upgraded, failed, results };
      statusCache = null;
      currentJob = null;
      liveRuns.delete('brew');
      io?.emit('software:changed', { reason: 'homebrew' });
    }
  });
  return { started: true, kind, names: selected.map((pkg) => pkg.name) };
}

/**
 * Hold (`brew pin`) or release (`brew unpin`) formulae, so a plain `brew upgrade` in a
 * terminal skips a package PortOS depends on until the owner releases it.
 */
export async function setHomebrewHold({ names, hold, io, deps = {} }) {
  const { platform = process.platform, run = runFile } = deps;
  const brew = deps.brew === undefined ? findBrew({ platform }) : deps.brew;
  assertSupported(platform, brew);
  if (currentJob) throw busyError();
  await run(brew, [hold ? 'pin' : 'unpin', ...names], safeChildProcessOptions({ env: brewEnv(), timeout: READ_TIMEOUT_MS })).catch((error) => {
    throw new ServerError(`brew ${hold ? 'pin' : 'unpin'} failed: ${String(error.stderr || error.message).trim()}`, { status: 502, code: 'HOMEBREW_PIN_FAILED' });
  });
  console.log(`🍺 Homebrew ${hold ? 'held' : 'released'}: ${names.join(', ')}`);
  statusCache = null;
  io?.emit('software:changed', { reason: 'homebrew' });
  return { names, held: hold };
}

export const __testing = {
  reset: () => { statusCache = null; currentJob = null; lastRun = null; liveRuns.delete('brew'); },
  getJob: () => currentJob,
  linkedFormulae,
};
