#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

// The CLI owns bail, not config evaluation: nested bare Vitest invocations
// inherit npm_lifecycle_event but must retain their own lifecycle policy.
const collecting = process.env.PORTOS_CI_COLLECTION === '1';
const args = process.argv.slice(2);
if (collecting && args.some(arg => /^--(?:bail|retry)(?:=|$)/.test(arg))) {
  throw Error('The CI entry point owns bail and retry policy.');
}
const result = spawnSync(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), ...args,
  ...(args.some(arg => /^--bail(?:=|$)/.test(arg)) ? [] : [`--bail=${collecting ? 5 : 1}`]), ...(collecting ? ['--retry=0'] : [])], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? (result.signal === 'SIGINT' ? 130 : result.signal === 'SIGTERM' ? 143 : 1);
