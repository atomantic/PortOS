import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { resolveImportGrowthBase } from './lib/importGrowth.js';

it('pins the real first parent in a two-commit shallow checkout and refuses a missing parent', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'poster-matrix-base-'));
  const source = join(scratch, 'source');
  const script = fileURLToPath(new URL('./posterCiMatrixBase.js', import.meta.url));
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git(scratch, 'init', source);
    git(source, 'config', 'user.name', 'Fixture');
    git(source, 'config', 'user.email', 'fixture@example.invalid');
    writeFileSync(join(source, 'fixture'), 'one');
    git(source, 'add', 'fixture');
    git(source, 'commit', '-m', 'base');
    const base = git(source, 'rev-parse', 'HEAD');
    writeFileSync(join(source, 'fixture'), 'two');
    git(source, 'commit', '-am', 'head');
    const head = git(source, 'rev-parse', 'HEAD');
    for (const depth of [1, 2]) {
      const checkout = join(scratch, `checkout-${depth}`);
      git(scratch, 'clone', '--depth', String(depth), `file://${source}`, checkout);
      const envFile = join(scratch, `env-${depth}`);
      writeFileSync(envFile, '');
      const result = spawnSync(process.execPath, [script], { cwd: checkout, encoding: 'utf8', env: { ...process.env, GITHUB_SHA: head, GITHUB_ENV: envFile } });
      if (depth === 1) {
        expect(result.status).not.toBe(0);
        expect(readFileSync(envFile, 'utf8')).toBe('');
      } else {
        expect(result.status, result.stderr).toBe(0);
        expect(readFileSync(envFile, 'utf8')).toContain(`CI_BASE_SHA=${base}`);
        expect(resolveImportGrowthBase({ repoRoot: checkout, env: { GITHUB_ACTIONS: 'true', CI_BASE_SHA: base } })).toEqual({ sha: base, source: 'CI_BASE_SHA' });
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
