import { diagnosticTestFile, persistTestDiagnostic, suiteErrorText, SUITE_ERROR_LIMIT } from './ci-test-diagnostics.js';

// Vitest JSON can omit suite hook errors and run-level errors. Capture those
// independently of stdout and keep them distinct from each other.
function errorDiagnostic(error, depth = 0) {
  if (!error || typeof error !== 'object') return String(error).slice(0, 8000);
  const lines = [error.type, error.stack || `${error.name || 'Error'}: ${error.message || ''}`];
  if (error.code !== undefined) lines.push(`code: ${error.code}`);
  if (error.cause && depth < 3) lines.push(`Caused by: ${errorDiagnostic(error.cause, depth + 1)}`);
  return lines.filter(Boolean).join('\n').slice(0, 8000);
}

const moduleStates = new Set(['queued', 'pending', 'passed', 'failed', 'skipped']);

function* suitesIn(module) {
  yield module;
  yield* module.children.allSuites();
}

export default function vitestRunDiagnostics() {
  const path = process.env.PORTOS_CI_DIAGNOSTICS_PATH;
  let snapshotExitCode = null;
  let diagnostics = { reason: 'not-finished', errorCount: 0, errors: [], completedCount: 0 };
  // Vitest's resolved cap, not the launcher's environment: the worker count that actually ran.
  let workers;
  const activeModules = new Set();
  const completedModules = [];
  const moduleResults = [];
  const suiteErrors = [];
  const persist = (processExit) => {
    if (!processExit) snapshotExitCode = process.exitCode ?? null;
    if (!path) return;
    persistTestDiagnostic(path, { ...diagnostics, ...(workers ? { workers } : {}), activeModules: [...activeModules].slice(0, 100),
      completedModules, moduleResults, suiteErrors, exitCode: snapshotExitCode,
      ...(processExit ? { processExit } : {}) });
  };
  return {
    onInit(vitest) {
      const resolved = Number(vitest.config?.maxWorkers);
      if (Number.isInteger(resolved) && resolved > 0) workers = resolved;
      // Exit listeners can only do synchronous I/O. Preserve the ordinary hook
      // snapshot separately: the event is later evidence, not a causal verdict.
      const onExit = (eventCode) => {
        const processExit = { eventCode, exitCode: process.exitCode ?? null };
        persist(processExit);
      };
      if (path) process.once('exit', onExit);
      vitest.onClose(() => persist());
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
      if (state === 'failed' && suiteErrors.length < SUITE_ERROR_LIMIT) {
        for (const suite of suitesIn(module)) {
          for (const error of suite.errors()) {
            suiteErrors.push({
              file,
              suite: suiteErrorText(suite === module ? '<module>' : suite.fullName, module.moduleId),
              summary: suiteErrorText(`${error.name || 'Error'}: ${error.message || ''}`, module.moduleId),
            });
            if (suiteErrors.length === SUITE_ERROR_LIMIT) break;
          }
          if (suiteErrors.length === SUITE_ERROR_LIMIT) break;
        }
      }
      diagnostics.completedCount += 1;
      persist();
    },
    onTestRunEnd(_modules, errors, reason) {
      diagnostics = { ...diagnostics, reason, errorCount: Math.max(diagnostics.errorCount, errors.length),
        errors: [...new Set([...diagnostics.errors, ...errors.map(error => errorDiagnostic(error))])].slice(0, 10) };
      persist();
    },
    onProcessTimeout() {
      diagnostics = { ...diagnostics, teardownTimeout: true };
      persist();
    },
  };
}
