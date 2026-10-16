import { diagnosticTestFile, persistTestDiagnostic } from './ci-test-diagnostics.js';
import { fileURLToPath } from 'node:url';

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
const threeFile = 'server/services/musicVideo/documentRender.browser.test.js';
const threeCase = 'authors a local Three.js world and renders the same deterministic scene through module preview and export';
function failureKind(errors) {
  const bounded = Array.isArray(errors) ? errors.slice(0, 10) : [];
  if (bounded.some(error => typeof error?.message === 'string' && /^(Test|Hook) timed out in \d{1,9}ms(?:\.| while waiting for )/.test(error.message))) return 'timeout';
  return bounded.some(error => error?.name === 'AssertionError') ? 'assertion' : 'other';
}
function failureLocations(errors, moduleId) {
  const file = diagnosticTestFile(moduleId);
  if (!/^(server|client|scripts|lib|autofixer)\//.test(file)) return [];
  const expected = fileURLToPath(new URL(`../${file}`, import.meta.url)).replace(/\\/g, '/');
  const normalize = path => {
    try { return (path.startsWith('file://') ? fileURLToPath(path) : path).replace(/\\/g, '/'); }
    catch { return ''; }
  };
  if (typeof moduleId !== 'string' || normalize(moduleId) !== expected) return [];
  const locations = [];
  const admit = frame => {
    if (typeof frame?.file !== 'string' || normalize(frame.file) !== expected
      || ![frame.line, frame.column].every(value => Number.isInteger(value) && value > 0 && value <= 10000000)) return;
    if (locations.length < 3 && !locations.some(item => item.line === frame.line && item.column === frame.column)) locations.push({ line: frame.line, column: frame.column });
  };
  for (const error of Array.isArray(errors) ? errors.slice(0, 10) : []) {
    for (const frame of Array.isArray(error?.stacks) ? error.stacks.slice(0, 100) : []) admit(frame);
    // Vitest may not have parsed the stack yet when this reporter hook runs.
    for (const line of typeof error?.stack === 'string' ? error.stack.slice(0, 8000).split('\n').slice(0, 100) : []) {
      const match = /^\s*at (?:.* \()?(.+?):(\d{1,8}):(\d{1,8})\)?$/.exec(line);
      if (match) admit({ file: match[1], line: Number(match[2]), column: Number(match[3]) });
    }
  }
  return locations;
}

export default function vitestRunDiagnostics() {
  let diagnostics = { reason: 'not-finished', errorCount: 0, errors: [], completedCount: 0 };
  const activeModules = new Set();
  const completedModules = [];
  const moduleResults = [];
  const failedCases = [];
  const persist = () => {
    const path = process.env.PORTOS_CI_DIAGNOSTICS_PATH;
    if (!path) return;
    persistTestDiagnostic(path, { ...diagnostics, activeModules: [...activeModules].slice(0, 100),
      completedModules, moduleResults, failedCases, exitCode: process.exitCode ?? null });
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
    onTestCaseResult(test) {
      const result = test.result();
      if (result.state !== 'failed' || failedCases.length >= 10) return;
      const file = diagnosticTestFile(test.module.moduleId);
      failedCases.push({ file, kind: failureKind(result.errors), locations: failureLocations(result.errors, test.module.moduleId),
        ...(file === threeFile && test.name === threeCase ? { identity: 'generated-three-preview-export' } : {}) });
      // Persist before run-end/JSON reporting, which bail or teardown can prevent.
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
