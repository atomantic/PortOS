import { readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reportWindowsCrashDiagnostics } from './ci-windows-crash-diagnostics.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import { writeStepSummary } from './lib/githubOutput.js';

const repoRoot = fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/');

// Publish repository identities only; never expose a runner's private paths.
export function diagnosticTestFile(value) {
  const normalized = String(value ?? '').replace(/\\/g, '/');
  if (normalized.length > 1000) return '<unavailable>';
  const path = normalized.startsWith(repoRoot) ? normalized.slice(repoRoot.length) : normalized.replace(/^\.\.?\//, '');
  if (path.length <= 240 && /^(?:server|client|scripts|lib|autofixer)\/(?:[\w.-]+\/)*[\w.-]+$/.test(path)
    && !path.split('/').includes('..')) return path;
  const name = basename(normalized);
  return /^[\w.-]+\.test\.[\w]+$/.test(name) ? `<outside-repository>/${name}` : '<unavailable>';
}

export function persistTestDiagnostic(path, value) {
  try {
    writeFileSync(`${path}.tmp`, JSON.stringify(value));
    renameSync(`${path}.tmp`, path);
  } catch {
    console.error('Unable to persist CI test diagnostics.');
  }
}

function readReport(path, limit = 100_000) {
  if (statSync(path).size > limit) throw new Error('report exceeds limit');
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Independent of the launcher's close callback. Only bounded projections reach
// logs/summary: raw reports, error messages and environment values stay private.
export async function collectTestDiagnostics(root, {
  diagnose = reportWindowsCrashDiagnostics, logger = console, writeSummary = writeStepSummary,
} = {}) {
  const lines = [];
  let startedAt;
  let attempts = [];
  try {
    attempts = readdirSync(root).filter(name => /^portos-vitest-[\w-]+$/.test(name));
    const start = name => {
      try { return Number(readReport(join(root, name, 'invocation.json')).startedAt) || 0; }
      catch { return 0; }
    };
    attempts.sort((a, b) => start(a) - start(b));
    if (attempts.length > 2) lines.push('Diagnostic gap: more than two invocations; collecting only the last two.');
  } catch {
    lines.push('Diagnostic gap: invocation directory unavailable.');
  }
  if (!attempts.length) lines.push('Inconclusive failure: no persisted test invocation; launcher completion is unverified.');
  for (const [index, name] of attempts.slice(-2).entries()) {
    const dir = join(root, name);
    lines.push(`CI test invocation ${index + 1}:`);
    try {
      const invocation = readReport(join(dir, 'invocation.json'));
      if (!Number.isFinite(invocation.startedAt) || typeof invocation.completed !== 'boolean') throw Error('invalid invocation');
      startedAt = Math.min(startedAt ?? invocation.startedAt, invocation.startedAt);
      lines.push(`Launcher ${invocation.completed ? 'completed' : 'interrupted or completion not recorded'}; `
        + `exit=${Number.isInteger(invocation.status) ? invocation.status : 'unavailable'}; `
        + `signal=${/^SIG[A-Z]+$/.test(invocation.signal) ? invocation.signal : 'none'}.`);
      if (Array.isArray(invocation.selectors)) lines.push(`Selected inputs (up to 100): ${invocation.selectors.slice(0, 100).map(diagnosticTestFile).join(', ') || 'full suite or no file selectors'}`);
    } catch {
      lines.push('Diagnostic gap: invocation metadata unavailable; launcher completion is unverified.');
    }
    try {
      const run = readReport(join(dir, 'run.json'), 160_000);
      if (!Array.isArray(run.activeModules) || !Array.isArray(run.completedModules)
        || !Number.isInteger(run.completedCount) || !Number.isInteger(run.errorCount)) throw Error('invalid progress');
      const reason = ['passed', 'failed', 'interrupted', 'not-finished'].includes(run.reason) ? run.reason : 'unavailable';
      lines.push(`Vitest progress: reason=${reason}; completed=${run.completedCount}; unhandledErrors=${run.errorCount}.`);
      lines.push(`Queued/unfinished modules (up to 100): ${run.activeModules.slice(0, 100).map(diagnosticTestFile).join(', ') || 'none recorded'}`);
      lines.push(`Last completed modules (up to 100): ${run.completedModules.slice(-100).map(diagnosticTestFile).join(', ') || 'none recorded'}`);
      // Older reporters omit these fields. New outcomes remain independently
      // useful when interruption prevents the final JSON reporter from writing.
      if (Array.isArray(run.moduleResults)) {
        const results = run.moduleResults.slice(-100).filter(item => item && ['queued', 'pending', 'passed', 'failed', 'skipped', 'unavailable'].includes(item.state));
        lines.push(`Module outcomes (up to 100): ${results.map(item => `${diagnosticTestFile(item.file)}=${item.state}`).join(', ') || 'none recorded'}`);
      }
      if (Array.isArray(run.failedCases)) {
        const kinds = ['timeout', 'assertion', 'other', 'frame-freshness', 'preparation-superseded', 'async-drawing', 'scene-changed', 'source-changed',
          'playback-timeout', 'playback-failed', 'playback-disposed', 'playback-argument', 'playback-anchor', 'playback-not-prepared',
          'browser-closed', 'browser-timeout', 'browser-protocol', 'browser-crashed', 'browser-evaluation-stalled'];
        const cases = run.failedCases.slice(0, 10).filter(item => item && kinds.includes(item.kind));
        lines.push(`Failed case categories (up to 10): ${cases.map(item => {
          const locations = Array.isArray(item.locations) ? item.locations.slice(0, 3).filter(location => location
            && [location.line, location.column].every(value => Number.isInteger(value) && value > 0 && value <= 10000000)) : [];
          return `${diagnosticTestFile(item.file)}=${item.kind}`
            + (item.identity === 'generated-three-preview-export' && diagnosticTestFile(item.file) === 'server/services/musicVideo/documentRender.browser.test.js'
              ? ':generated-three-preview-export' : '')
            + (locations.length ? ` at ${locations.map(location => `${location.line}:${location.column}`).join('/')}` : '');
        }).join(', ') || 'none recorded'}`);
      }
    } catch {
      lines.push('Diagnostic gap: Vitest progress unavailable; active test file is unknown.');
    }
    try {
      const report = readReport(join(dir, 'failures.json'), 32 * 1024 * 1024);
      if (!Array.isArray(report.testResults)) throw Error('invalid failures');
      const failed = report.testResults.filter(suite => suite.status === 'failed');
      lines.push(failed.length
        ? `Failed suites (up to 10): ${failed.slice(0, 10).map(suite => diagnosticTestFile(suite.name)).join(', ')}`
        : 'Inconclusive failure: structured report contains no failed suite.');
    } catch {
      lines.push('Inconclusive failure: structured test report missing, malformed, or oversized.');
    }
  }
  for (const line of lines) logger.warn(line);
  try { writeSummary(lines.join('\n\n')); }
  catch { logger.warn('CI test diagnostic summary unavailable; see the job log.'); }
  // Without invocation metadata, explicitly use the step's 15-minute budget.
  if (startedAt === undefined) logger.warn('Windows event query uses a fallback 15-minute window; invocation start is unknown.');
  try { await diagnose(startedAt ?? Date.now() - 15 * 60_000); }
  catch { logger.warn('Windows native crash diagnostics unavailable.'); }
  return lines;
}

if (isDirectlyInvoked(import.meta.url)) {
  try { await collectTestDiagnostics(process.env.PORTOS_CI_DIAGNOSTICS_DIR); }
  catch { console.error('CI test diagnostic collection unavailable; original test failure is unchanged.'); }
}
