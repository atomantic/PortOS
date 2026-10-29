#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import { writeStepEnv } from './lib/githubOutput.js';

export function posterMatrixBase({ cwd = process.cwd(), expectedHead = process.env.GITHUB_SHA } = {}) {
  const resolve = revision => {
    const result = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`], { cwd, encoding: 'utf8' });
    if (result.error || result.status !== 0) throw Error(`Cannot resolve ${revision}; the poster matrix requires its checkout and first parent`);
    return result.stdout.trim();
  };
  const head = resolve('HEAD');
  if (expectedHead && head !== expectedHead) throw Error('Poster matrix checkout does not match the dispatched revision');
  return { head, base: resolve('HEAD^1') };
}

if (isDirectlyInvoked(import.meta.url)) {
  const { head, base } = posterMatrixBase();
  writeStepEnv('CI_BASE_SHA', base);
  console.log(`Poster matrix revision ${head}; import-growth base ${base}`);
}
