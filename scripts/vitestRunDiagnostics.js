import { writeFileSync } from 'node:fs';

// The JSON reporter includes test failures, but drops run-level errors such as
// unhandled rejections and worker crashes. Keep those independently of stdout.
function errorDiagnostic(error, depth = 0) {
  if (!error || typeof error !== 'object') return String(error).slice(0, 8000);
  const lines = [error.type, error.stack || `${error.name || 'Error'}: ${error.message || ''}`];
  if (error.code !== undefined) lines.push(`code: ${error.code}`);
  if (error.cause && depth < 3) lines.push(`Caused by: ${errorDiagnostic(error.cause, depth + 1)}`);
  return lines.filter(Boolean).join('\n').slice(0, 8000);
}

export default function vitestRunDiagnostics() {
  let diagnostics = { reason: 'not-finished', errorCount: 0, errors: [] };
  const persist = () => {
    const path = process.env.PORTOS_CI_DIAGNOSTICS_PATH;
    if (!path) return;
    try {
      writeFileSync(path, JSON.stringify({ ...diagnostics, exitCode: process.exitCode ?? null }));
    } catch {
      // Diagnostic I/O must never turn a passing test run into a failure.
      console.error('Unable to persist Vitest run diagnostics.');
    }
  };
  return {
    onInit(vitest) {
      vitest.onClose(persist);
    },
    onTestRunEnd(_modules, errors, reason) {
      diagnostics = { reason, errorCount: errors.length, errors: errors.slice(0, 10).map(error => errorDiagnostic(error)) };
      persist();
    },
    onProcessTimeout() {
      diagnostics = { ...diagnostics, teardownTimeout: true };
      persist();
    },
  };
}
