import { opendir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getRunOwner } from '../lib/aiToolkit/internal/runOwnership.js';
import { finalizeRunRecord, getRunsPath } from './runner.js';

const validProcess = (value) => value && Number.isSafeInteger(value.pid) && value.pid > 0
  && typeof value.startedAt === 'string' && Number.isFinite(Date.parse(value.startedAt));
const isGone = (pid) => {
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
};

// One streaming pass over existing records. No retries, age inference, provider
// calls or process termination; uncertainty leaves the original record intact.
export async function recoverInterruptedRuns({ owner = getRunOwner(), isDead = isGone, now = Date.now } = {}) {
  const runsPath = getRunsPath();
  const directory = await opendir(runsPath).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  let recovered = 0;
  if (!directory) return { recovered };
  for await (const entry of directory) {
    if (!entry.isDirectory()) continue;
    try {
      const runDir = join(runsPath, entry.name);
      // A directory without metadata is the leftover of a process that died
      // between creating it and writing the record: nothing to recover.
      const raw = await readFile(join(runDir, 'metadata.json'), 'utf8').catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (raw === null) continue;
      const run = JSON.parse(raw);
      if (!run ||run.id !== entry.name || run.agentId || run.endTime != null || run.success != null) continue;
      const previous = run.executionOwner;
      if (!validProcess(previous) || typeof previous.id !== 'string' || !previous.id
        || previous.id === owner.id || previous.pid === owner.pid || !isDead(previous.pid)) continue;
      const child = run.executionChild;
      if (run.executionKind === 'api') {
        if (child !== null) continue;
      } else if (run.executionKind === 'cli' || run.executionKind === 'tui') {
        if (!validProcess(child) || !isDead(child.pid)) continue;
      } else continue;
      const startTime = Date.parse(run.startTime);
      const observedAt = now();
      if (!Number.isFinite(startTime) || observedAt < startTime) continue;
      const output = await readFile(join(runDir, 'output.txt'), 'utf8').catch(error => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      await finalizeRunRecord({
        runId: run.id, output, exitCode: null, success: false, startTime,
        error: 'Run interrupted by server exit; end observed during startup recovery',
        reportFailure: false,
        extras: {
          canceled: true, completionReason: 'host-interrupted',
          endTime: new Date(observedAt).toISOString(), duration: observedAt - startTime,
          endTimeSource: 'recovery-observation',
        },
      });
      recovered += 1;
    } catch (error) {
      console.error(`❌ Interrupted run recovery could not inspect or finalize a record: ${error.message}`);
    }
  }
  if (recovered) console.log(`🛟 Closed ${recovered} interrupted in-process runs at their observed end`);
  return { recovered };
}
