import { diagnosticTestFile, persistTestDiagnostic } from './ci-test-diagnostics.js';

// The JSON reporter includes test failures, but drops run-level errors such as
// unhandled rejections and worker crashes. Keep those independently of stdout.
function errorDiagnostic(error, depth = 0) {
  if (!error || typeof error !== 'object') return String(error).slice(0, 8000);
  const lines = [error.type, error.stack || `${error.name || 'Error'}: ${error.message || ''}`];
  if (error.code !== undefined) lines.push(`code: ${error.code}`);
  if (error.cause && depth < 3) lines.push(`Caused by: ${errorDiagnostic(error.cause, depth + 1)}`);
  return lines.filter(Boolean).join('\n').slice(0, 8000);
}

const moduleStates = new Set(['queued', 'pending', 'passed', 'failed', 'skipped']);

export default function vitestRunDiagnostics() {
  let diagnostics = { reason: 'not-finished', errorCount: 0, errors: [], completedCount: 0 };
  const activeModules = new Set();
  const completedModules = [];
  const moduleResults = [];
  const persist = () => {
    const path = process.env.PORTOS_CI_DIAGNOSTICS_PATH;
    if (!path) return;
    persistTestDiagnostic(path, { ...diagnostics, activeModules: [...activeModules].slice(0, 100),
      completedModules, moduleResults, exitCode: process.exitCode ?? null });
  };
  return {
    onInit(vitest) {
      vitest.onClose(persist);
      persist();
    },
    onTestModuleQueued(module) {
      // Queued includes import/collection, before any test body can run.
      activeModules.add(diagnosticTestFile(module.moduleId));
      persist();
    },
    onTestModuleEnd(module) {
      const file = diagnosticTestFile(module.moduleId);
      activeModules.delete(file);
      completedModules.push(file);
      if (completedModules.length > 100) completedModules.shift();
      const state = module.state?.();
      moduleResults.push({ file, state: moduleStates.has(state) ? state : 'unavailable' });
      if (moduleResults.length > 100) moduleResults.shift();
      diagnostics.completedCount += 1;
      persist();
    },
    onTestRunEnd(_modules, errors, reason) {
      diagnostics = { ...diagnostics, reason, errorCount: errors.length, errors: errors.slice(0, 10).map(error => errorDiagnostic(error)) };
      persist();
    },
    onProcessTimeout() {
      diagnostics = { ...diagnostics, teardownTimeout: true };
      persist();
    },
  };
}
