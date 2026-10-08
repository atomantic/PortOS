import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const hook = fileURLToPath(new URL('../.githooks/pre-commit', import.meta.url));
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const shellTest = process.platform === 'win32' ? it.skip : it;
shellTest('caps the actual hook suite, preserves lower budgets and propagates test failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'hook-budget-'));
  roots.push(root);
  const marker = join(root, 'invocation');
  for (const [name, text] of Object.entries({
    git: '#!/bin/bash\nif [ "$1" = rev-parse ]; then printf "%s\\n" "$FIXTURE_ROOT"; else printf "server/example.js\\n"; fi\n',
    npm: '#!/bin/bash\nprintf "%s %s %s" "$PORTOS_PREGATE_MAX_WORKERS" "$NODE_ENV" "$*" > "$FIXTURE_MARKER"\nexit "${FIXTURE_EXIT:-0}"\n',
  })) {
    writeFileSync(join(root, name), text);
    chmodSync(join(root, name), 0o755);
  }
  for (const [budget, expected, exitCode] of [['', '4', 0], ['2', '2', 0], ['12', '4', 0], ['invalid', '4', 7]]) {
    const result = spawnSync('bash', [hook], { encoding: 'utf8', env: {
      ...process.env, PATH: `${root}${delimiter}${process.env.PATH}`,
      FIXTURE_ROOT: root, FIXTURE_MARKER: marker, FIXTURE_EXIT: String(exitCode),
      PORTOS_PREGATE_MAX_WORKERS: budget, NODE_ENV: 'development',
    } });
    expect(result.status, result.stderr).toBe(exitCode);
    expect(readFileSync(marker, 'utf8')).toBe(`${expected} test test --prefix server`);
    if (exitCode) expect(result.stdout).not.toContain('checks passed');
  }
});
