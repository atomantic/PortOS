#!/usr/bin/env node
/** Add fixed-path Time Machine exclusions for regenerable churn on macOS. */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import { excludeFromTimeMachine } from './lib/timeMachineExclude.js';

const installRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function setupTimeMachine(root = installRoot, { log = console.log, ...options } = {}) {
  const result = excludeFromTimeMachine(root, options);
  if (result.status === 'updated') log(`💾 Added ${result.added} fixed-path Time Machine exclusions for regenerable PortOS directories`);
  if (result.status === 'partial') {
    for (const failure of result.failures) log(`⚠️ Time Machine exclusion failed for ${failure.path}: ${failure.error.replace(/\s+/g, ' ')}`);
    log('⚠️ Setup will continue. Fixed-path Time Machine exclusions require sudo; rerun node scripts/setup-timemachine.js to retry.');
  }
  return result;
}

if (isDirectlyInvoked(import.meta.url)) setupTimeMachine();
