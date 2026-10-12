import { fileURLToPath } from 'node:url';
import { bufferedSpawn } from '../server/lib/bufferedSpawn.js';
import { writeStepSummary } from './lib/githubOutput.js';

const scriptPath = fileURLToPath(new URL('./ci-windows-crash-diagnostics.ps1', import.meta.url));
const unavailable = 'Windows native crash diagnostics unavailable (query failed or invalid response).';

// Event messages, paths, machine names and dump contents can contain private
// data. Only these bounded, validated fields may reach logs or step summaries.
function diagnosticLine(event) {
  if (event?.AppName?.toLowerCase() !== 'node.exe') throw new Error('not a Node event');
  const field = (name, pattern) => {
    const value = event[name];
    return typeof value === 'string' && pattern.test(value) ? value : 'unavailable';
  };
  return 'Windows native crash candidate (Application Error 1000): '
    + `node=${field('AppVersion', /^\d[\d.]{0,39}$/)} `
    + `module=${field('ModuleName', /^[\w+-]{1,100}\.(?:dll|exe|node)$/i)} `
    + `moduleVersion=${field('ModuleVersion', /^\d[\d.]{0,39}$/)} `
    + `exception=${field('ExceptionCode', /^(?:0x)?[a-f\d]{8}$/i)} `
    + `offset=${field('FaultingOffset', /^(?:0x)?[a-f\d]{1,16}$/i)}`;
}

/**
 * Best-effort evidence before a retry/cancel can erase the crash context.
 * Events are candidates from this invocation's time window, not proof that
 * a particular module caused the worker crash. Never changes the test result.
 */
export async function reportWindowsCrashDiagnostics(startedAt, {
  platform = process.platform, run = bufferedSpawn, logger = console, writeSummary = writeStepSummary,
} = {}) {
  if (platform !== 'win32') return { outcome: 'not-windows' };
  let lines;
  let outcome;
  try {
    const since = new Date(startedAt).toISOString();
    const until = new Date().toISOString();
    const result = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', scriptPath], {
      timeoutMs: 10_000,
      env: { ...process.env, PORTOS_CRASH_SINCE: since, PORTOS_CRASH_UNTIL: until },
    });
    if (!result.success) throw new Error('event query failed');
    const events = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
    if (!Array.isArray(events) || events.length > 10) throw new Error('invalid events');
    lines = events.map(diagnosticLine);
    outcome = lines.length ? 'candidates' : 'no-events';
    if (!lines.length) lines = ['Windows native crash diagnostics: no matching Node Application Error event in this invocation; cause remains unverified.'];
  } catch {
    // In particular, never echo PowerShell stderr or an exception's message.
    lines = [unavailable];
    outcome = 'unavailable';
  }
  for (const line of lines) logger.warn(line);
  try {
    writeSummary(lines.join('\n\n'));
  } catch {
    logger.warn('Windows native crash diagnostic summary could not be written; see the job log.');
  }
  return { outcome };
}
