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
  const path = process.env.PORTOS_CI_DIAGNOSTICS_PATH;
  const collecting = process.env.PORTOS_CI_COLLECTION === '1';
  let context;
  const hooks = new Map();
  const reported = new Set();
  const collection = { limit: 5, failures: [], stop: null, coverage: 'unverified' };
  const stop = (reason, error) => {
    if (collection.stop && (collection.stop === 'unsafe' || reason !== 'unsafe')) return;
    collection.stop = reason;
    if (error) {
      diagnostics.errorCount += 1;
      diagnostics.errors.push(errorDiagnostic(error));
    }
    persist();
    // Do not await: cancelCurrentRun waits on this reporter's own run.
    void context.cancelCurrentRun('test-failure').catch(error => {
      diagnostics.errors.push(errorDiagnostic(error));
      persist();
    });
  };
  let snapshotExitCode = null;
  let diagnostics = { reason: 'not-finished', errorCount: 0, errors: [], completedCount: 0 };
  const activeModules = new Set();
  const completedModules = [];
  const moduleResults = [];
  const persist = (processExit) => {
    if (!processExit) snapshotExitCode = process.exitCode ?? null;
    if (!path) return;
    persistTestDiagnostic(path, { ...diagnostics, ...(collecting ? { collection } : {}), activeModules: [...activeModules].slice(0, 100),
      completedModules, moduleResults, exitCode: snapshotExitCode,
      ...(processExit ? { processExit } : {}) });
  };
  return {
    onInit(vitest) {
      context = vitest;
      if (collecting) {
        // Preserve Vitest's error recording; never suppress or reclassify it.
        const previous = vitest.state.onUnhandledError;
        vitest.state.onUnhandledError = (error) => {
          stop('unsafe', error);
          previous?.(error);
        };
      }
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
    onHookStart(hook) {
      if (collecting) hooks.set(hook.entity.id, hook.name);
    },
    onHookEnd(hook) {
      if (collecting) hooks.delete(hook.entity.id);
    },
    onTestCaseResult(test) {
      if (!collecting || reported.has(test.id)) return;
      const result = test.result();
      if (result.state !== 'failed') return;
      reported.add(test.id);
      // A failing hook never emits hook-end. An assertion thrown by a hook
      // is unsafe too, as are timeouts, fixture refusal and unknown errors.
      const errors = result.errors;
      if (!test.meta().portosDiagnosticRunner || test.meta().portosDiagnosticUnsafe || hooks.has(test.id) || !errors?.length || errors.some(error => error.name !== 'AssertionError')) {
        stop('unsafe', errors?.[0] || 'Unknown test failure');
        return;
      }
      if (collection.stop) return;
      collection.failures.push({ file: diagnosticTestFile(test.module.moduleId),
        name: test.fullName.slice(0, 1000), errors: errors.slice(0, 3).map(error => errorDiagnostic(error)) });
      persist();
      if (collection.failures.length === collection.limit) stop('assertion-limit');
    },
    onTestModuleEnd(module) {
      if (collecting && module.errors?.().length) stop('unsafe', module.errors()[0]);
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
      if (collecting && errors.length) stop('unsafe', errors[0]);
      if (collecting && !collection.stop && reason !== 'passed' && collection.failures.length === 0) stop('unsafe', 'Unknown run-level failure');
      diagnostics = { ...diagnostics, reason, errorCount: Math.max(diagnostics.errorCount, errors.length),
        errors: [...new Set([...diagnostics.errors, ...errors.map(error => errorDiagnostic(error))])].slice(0, 10) };
      if (collecting && reason === 'passed' && !collection.stop && !errors.length) collection.coverage = 'complete';
      persist();
    },
    onProcessTimeout() {
      if (collecting) stop('unsafe', 'Process teardown timed out');
      diagnostics = { ...diagnostics, teardownTimeout: true };
      persist();
    },
  };
}
