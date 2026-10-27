/** Native Windows agent-tree settlement. Reservations and receipts stay local
 * and outlive agent-history compaction; missing proof always retains the hold. */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { PATHS } from './fileUtils.js';
import { spawn } from './childProcess.js';
import { findCommandOnPath, windowsPowerShell51Path } from './processEnv.js';

const idSchema = z.string().regex(/^[a-zA-Z0-9_-]+$/);
const ownerSchema = z.object({ version: z.literal(1), agentId: idSchema, taskId: z.string(),
  startedAt: z.string().datetime(), nonce: z.string().uuid() }).strict();
const reservationSchema = z.object({ owner: ownerSchema, executable: z.string().min(1) }).strict();
const startedSchema = z.object({ owner: ownerSchema, pid: z.number().int().positive(), created: z.string().regex(/^[1-9][0-9]+$/) }).strict();
const receiptSchema = startedSchema.extend({ version: z.literal(1), settledAt: z.string().datetime(),
  active: z.literal(0), exitCode: z.number().int().min(0).max(0xffffffff) }).strict();
const directory = agentId => join(PATHS.cos, 'process-settlement', idSchema.parse(agentId));
const unavailable = () => Object.assign(new Error('Windows agent process settlement is unverified'), { code: 'WINDOWS_AGENT_PROCESS_UNVERIFIED' });
let compiled;

async function supervisor() {
  if (!compiled) compiled = (async () => {
    const root = join(PATHS.cos, 'process-supervisors');
    await mkdir(root, { recursive: true, mode: 0o700 });
    // Never execute a pre-existing binary. Reuse only this process's compilation.
    const target = await mkdtemp(join(root, 'windows-'));
    const source = join(target, 'supervisor.cs');
    const executable = join(target, 'supervisor.exe');
    await writeFile(source, await readFile(new URL('./windowsAgentSupervisor.cs', import.meta.url)), { mode: 0o600 });
    const quote = value => `'${value.replaceAll("'", "''")}'`;
    const script = `$ErrorActionPreference='Stop'; Add-Type -Path ${quote(source)} -ReferencedAssemblies System.Web.Extensions -OutputAssembly ${quote(executable)} -OutputType ConsoleApplication`;
    await new Promise((resolve, reject) => {
      const compiler = spawn(windowsPowerShell51Path(), ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore' });
      const timer = setTimeout(() => { compiler.kill(); reject(unavailable()); }, 15000);
      compiler.once('error', () => { clearTimeout(timer); reject(unavailable()); });
      compiler.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(unavailable()); });
    });
    return executable;
  })().catch(error => { compiled = null; throw error; });
  return compiled;
}

/** Called at server-controlled registration, before any agent child exists. */
export async function reserveWindowsAgentProcess(agent) {
  if (process.platform !== 'win32') return;
  const owner = ownerSchema.parse({ version: 1, agentId: agent.id, taskId: agent.taskId,
    startedAt: agent.startedAt, nonce: randomUUID() });
  const executable = await supervisor();
  await mkdir(directory(agent.id), { mode: 0o700, recursive: true });
  await writeFile(join(directory(agent.id), 'owner.json'), JSON.stringify({ owner, executable }), { flag: 'wx', mode: 0o600 });
}

/** Synchronous so PTY/child terminal listeners can attach in the spawning tick.
 * Legacy/unregistered callers retain their old launch and cannot gain proof. */
export function prepareWindowsAgentLaunch(agentId, command, args, { cwd, env, pty = false } = {}) {
  if (process.platform !== 'win32' || !agentId) return { command, args };
  if ([command, cwd, ...args].some(value => typeof value === 'string' && value.includes('\0'))) {
    throw new TypeError('Windows agent launch contains NUL bytes');
  }
  let reservation;
  try { reservation = reservationSchema.parse(JSON.parse(readFileSync(join(directory(agentId), 'owner.json'), 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return { command, args }; throw unavailable(); }
  const resolved = findCommandOnPath(command, { env, cwd });
  if (!resolved) throw unavailable();
  const spec = join(directory(agentId), 'launch.json');
  // A duplicate dispatch must not create a second writer for this agent/start.
  writeFileSync(spec, JSON.stringify({ owner: reservation.owner, command: resolved, args, cwd, pty }), { flag: 'wx', mode: 0o600 });
  return { command: reservation.executable, args: [spec], settlementDirectory: directory(agentId) };
}

/** Stop through the supervisor so it can persist kernel-backed settlement.
 * Lost/unreadable supervision remains a hold; PID-based fallback cannot prove it. */
export function watchWindowsAgentProcess(child, launch) {
  if (!launch.settlementDirectory) return child;
  const cancel = () => {
    writeFileSync(join(launch.settlementDirectory, 'cancel'), '', { mode: 0o600 });
    if (Object.hasOwn(child, 'killed')) child.killed = true;
    return true;
  };
  const originalKill = child.kill.bind(child);
  child.requestWindowsAgentStop = cancel;
  child.kill = signal => signal === 0 || signal === '0' ? originalKill(signal) : cancel();
  return child;
}

/** Read durable server-origin launch/settlement evidence after restart. The
 * native handle/creation time, rather than a recycled PID, binds the proof. */
export async function readWindowsAgentSettlement(agent) {
  const read = async name => JSON.parse(await readFile(join(directory(agent.id), name), 'utf8'));
  try {
    const { owner } = reservationSchema.parse(await read('owner.json'));
    if (owner.agentId !== agent.id || owner.taskId !== agent.taskId || owner.startedAt !== agent.startedAt) throw unavailable();
    const launch = await read('launch.json');
    const started = startedSchema.parse(await read('started.json'));
    const receipt = receiptSchema.parse(await read('settled.json'));
    if (![launch, started, receipt].every(record => isDeepStrictEqual(record.owner, owner))
      || started.pid !== receipt.pid || started.created !== receipt.created
      || Date.parse(receipt.settledAt) < Date.parse(owner.startedAt) || Date.parse(receipt.settledAt) > Date.now()) throw unavailable();
    return receipt;
  } catch { throw unavailable(); }
}
