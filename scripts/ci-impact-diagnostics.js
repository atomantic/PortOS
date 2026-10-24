#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import { writeStepSummary } from './lib/githubOutput.js';

export const IMPACT_STAGES = ['admission', 'base', 'hidden-content', 'import-case', 'plan', 'node-minimum', 'summary', 'autofixer-install', 'syntax'];
const OWNER_KEY = 'PORTOS_CI_IMPACT_OWNER';
const validToken = value => typeof value === 'string' && /^[\da-f-]{36}$/.test(value);
const codeValue = value => Number.isInteger(value) && value >= 0 && value <= 255 ? value : null;
const signalValue = value => /^SIG[A-Z0-9]{1,12}$/.test(value ?? '') ? value : null;

// Observe same-user Linux processes without reading argv or publishing identity.
// An inherited nonce establishes attribution; a missing/unreadable snapshot is
// unknown, never zero. Processes that deliberately clear their env are not covered.
export function scanImpactOwners(tokens, { procRoot = '/proc', platform = process.platform, uid = process.getuid?.(), budgetMs = 1000 } = {}) {
  const counts = Object.fromEntries(tokens.map(token => [token, 0]));
  let coverage = 'complete';
  const start = performance.now();
  if (platform !== 'linux' || !Number.isInteger(uid) || tokens.some(token => !validToken(token))) return { coverage: 'unavailable', counts: {} };
  try {
    const pids = readdirSync(procRoot).filter(name => /^\d+$/.test(name));
    if (pids.length > 4096) return { coverage: 'unavailable', counts: {} };
    for (const pid of pids) {
      if (performance.now() - start > budgetMs) { coverage = 'partial'; break; }
      const dir = join(procRoot, pid);
      try {
        if (statSync(dir).uid !== uid) continue;
        const before = readFileSync(join(dir, 'stat'), 'utf8');
        const fields = before.slice(before.lastIndexOf(')') + 2).split(' ');
        if (fields.length < 20 || !/^\d+$/.test(fields[19])) { coverage = 'partial'; continue; }
        if (['Z', 'X'].includes(fields[0])) continue;
        const env = readFileSync(join(dir, 'environ'));
        const after = readFileSync(join(dir, 'stat'), 'utf8');
        if (before.slice(before.lastIndexOf(')') + 2).split(' ')[19] !== after.slice(after.lastIndexOf(')') + 2).split(' ')[19]) {
          coverage = 'partial'; continue;
        }
        for (const token of tokens) {
          const marker = Buffer.from(`${OWNER_KEY}=${token}\0`);
          const index = env.indexOf(marker);
          if (index === 0 || (index > 0 && env[index - 1] === 0)) counts[token]++;
        }
      } catch (error) {
        // Disappearance during the snapshot is normal. Permission/I/O gaps are not.
        if (!['ENOENT', 'ESRCH'].includes(error.code)) coverage = 'partial';
      }
    }
    return { coverage, counts };
  } catch { return { coverage: 'unavailable', counts: {} }; }
}

function persist(root, stage, value) {
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const path = join(root, `${stage}.json`);
    writeFileSync(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
    return true;
  } catch { return false; }
}

function evidence(stage, boundary, values, log = console.log) {
  log(`CI impact ${JSON.stringify({ stage, boundary, ...values })}`);
}

// Child output and GitHub command files pass through unchanged. These records
// observe the direct command's events; they do not claim runner/job completion.
export async function observeImpactStage(stage, command, args, {
  root = process.env.PORTOS_CI_IMPACT_DIAGNOSTICS, env = process.env,
  scan = scanImpactOwners, log = console.log,
} = {}) {
  if (!IMPACT_STAGES.includes(stage) || !command) throw Error('Invalid impact stage invocation.');
  const token = randomUUID();
  const startedAt = Date.now();
  const start = performance.now();
  const elapsedMs = () => Math.round(performance.now() - start);
  const state = { stage, token, startedAt, exit: null, close: null };
  const save = () => evidence(stage, 'persist', { recorded: persist(root, stage, state) }, log);
  save();
  evidence(stage, 'start', { elapsedMs: 0 }, log);
  const child = spawn(command, args, { env: { ...env, [OWNER_KEY]: token }, stdio: 'inherit', shell: false });
  const result = await new Promise(resolve => {
    child.once('error', () => evidence(stage, 'spawn-error', { elapsedMs: elapsedMs() }, log));
    child.once('exit', (code, signal) => {
      state.exit = { code: codeValue(code), signal: signalValue(signal), elapsedMs: elapsedMs() };
      save();
      evidence(stage, 'exit', state.exit, log);
    });
    child.once('close', (code, signal) => {
      state.close = { code: codeValue(code), signal: signalValue(signal), elapsedMs: elapsedMs() };
      const snapshot = scan([token]);
      state.ownedAfterClose = { coverage: snapshot.coverage, count: snapshot.counts[token] ?? null };
      save();
      evidence(stage, 'close', { ...state.close, owned: state.ownedAfterClose.count, coverage: snapshot.coverage }, log);
      resolve({ code: codeValue(code), signal: signalValue(signal) });
    });
  });
  return result;
}

export function reportImpactSettlement(root, { scan = scanImpactOwners, log = console.log, summary = writeStepSummary } = {}) {
  const records = IMPACT_STAGES.map(stage => {
    try {
      const path = join(root, `${stage}.json`);
      if (statSync(path).size > 4096) throw Error('oversized');
      const record = JSON.parse(readFileSync(path, 'utf8'));
      if (record.stage !== stage || !validToken(record.token)) throw Error('invalid');
      return record;
    } catch { return { stage }; }
  });
  const tokens = records.map(record => record.token).filter(Boolean);
  const snapshot = scan(tokens);
  const lines = ['### Impact command settlement', '', 'This checkpoint precedes checkout post-actions and runner finalization.'];
  for (const record of records) {
    const row = {
      recorded: Boolean(record.token),
      exit: codeValue(record.exit?.code), close: codeValue(record.close?.code),
      signal: signalValue(record.close?.signal),
      owned: record.token ? snapshot.counts[record.token] ?? null : null,
      coverage: record.token ? snapshot.coverage : 'unavailable',
    };
    evidence(record.stage, 'settlement', row, log);
    lines.push(`- ${record.stage}: recorded=${row.recorded}; exit=${row.exit}; close=${row.close}; signal=${row.signal}; owned=${row.owned}; coverage=${row.coverage}.`);
  }
  lines.push('', 'Unknown/missing evidence is not proof of settlement. No processes were signalled or deleted.');
  try { summary(lines.join('\n')); }
  catch { evidence('settlement', 'summary-unavailable', {}, log); }
  return records;
}

async function main() {
  const [stage, separator, command, ...args] = process.argv.slice(2);
  if (stage === 'settlement' && separator === undefined) {
    reportImpactSettlement(process.env.PORTOS_CI_IMPACT_DIAGNOSTICS);
    return;
  }
  if (separator !== '--') throw Error('Invalid impact stage invocation.');
  const result = await observeImpactStage(stage, command, args);
  // A signal/spawn failure must stay red; never infer success from a null code.
  process.exitCode = result.code ?? 1;
}

if (isDirectlyInvoked(import.meta.url)) main().catch(() => {
  console.error('CI impact diagnostics invocation failed.');
  process.exitCode = 1;
});
