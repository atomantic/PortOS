import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const hook = fileURLToPath(new URL('../.githooks/pre-commit', import.meta.url));
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const shellTest = process.platform === 'win32' ? it.skip : it;

// Fixture PATH: `git` answers rev-parse with the fixture root and reports the
// staged list from FIXTURE_STAGED; `node` records its argv; `npm` records that
// it was reached at all. The hook must reach pregate through node and nothing
// through npm — `npm run build --prefix client` publishes the branch's client
// build into the dist the running install serves (#12045).
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hook-pregate-'));
  roots.push(root);
  for (const [name, text] of Object.entries({
    git: '#!/bin/bash\nif [ "$1" = rev-parse ]; then printf "%s\\n" "$FIXTURE_ROOT"; else printf "%s\\n" "$FIXTURE_STAGED"; fi\n',
    node: '#!/bin/bash\nprintf "%s" "$*" > "$FIXTURE_ROOT/node-args"\nexit "${FIXTURE_EXIT:-0}"\n',
    npm: '#!/bin/bash\nprintf "%s" "$*" > "$FIXTURE_ROOT/npm-args"\nexit 1\n',
  })) {
    writeFileSync(join(root, name), text);
    chmodSync(join(root, name), 0o755);
  }
  return root;
}

function runHook(root, env) {
  return spawnSync('bash', [hook], { encoding: 'utf8', env: {
    ...process.env, PATH: `${root}${delimiter}${process.env.PATH}`, FIXTURE_ROOT: root, ...env,
  } });
}

shellTest('runs pregate for staged changes and propagates its exit code', () => {
  for (const [exitCode, staged] of [[0, 'server/example.js'], [7, 'client/src/App.jsx'], [0, 'docs/README.md']]) {
    const root = fixture();
    const result = runHook(root, { FIXTURE_STAGED: staged, FIXTURE_EXIT: String(exitCode) });
    expect(result.status, result.stderr).toBe(exitCode);
    expect(readFileSync(join(root, 'node-args'), 'utf8')).toBe('scripts/pregate.js');
    expect(existsSync(join(root, 'npm-args')), 'the hook reached npm').toBe(false);
    expect(result.stdout.includes('checks passed')).toBe(exitCode === 0);
  }
});

shellTest('does nothing when nothing is staged', () => {
  const root = fixture();
  const result = runHook(root, { FIXTURE_STAGED: '' });
  expect(result.status, result.stderr).toBe(0);
  expect(existsSync(join(root, 'node-args'))).toBe(false);
  expect(existsSync(join(root, 'npm-args'))).toBe(false);
});

it('never publishes the client build or runs a workspace suite directly', () => {
  // Comment lines may name the old commands as history; only executable lines count.
  const source = readFileSync(hook, 'utf8').split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
  expect(source).not.toMatch(/publish-client-build|npm run build|npm test|vitest/);
  expect(source).toContain('node scripts/pregate.js');
});
