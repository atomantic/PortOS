// @vitest-environment node
/**
 * The CI runner's enumeration of the client workspace must collect exactly
 * what client/vitest.config.js collects. The server half of this contract is
 * scripts/lib/workspaceTests.test.js; this half runs where the client
 * workspace is installed, which the server CI job is not.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { listWorkspaceTests } from '../../../scripts/lib/workspaceTests.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

it('collects the same files as `vitest list` for client', () => {
  // Through node, not the .bin shim: the shim is a shell script (.cmd on Windows) execFileSync cannot start there.
  const listed = execFileSync(process.execPath, [join(REPO_ROOT, 'client', 'node_modules', 'vitest', 'vitest.mjs'),
    'list', '--filesOnly', '--configLoader', 'runner'], {
      cwd: join(REPO_ROOT, 'client'), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, PORTOS_CI_TEST_SELECTION: '' },
    })
    .split('\n').map((line) => line.trim().replace(/^\[[^\]]+\] /, '')).filter(Boolean);
  expect(listed.length).toBeGreaterThan(100);
  expect(listWorkspaceTests('client', { repoRoot: REPO_ROOT, env: {} })).toEqual([...new Set(listed)].sort());
}, 120_000);
