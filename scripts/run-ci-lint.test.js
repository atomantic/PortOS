import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { BIOME_BIN, LINT_MODES, SERVER_LINT_ARGS, buildLintArgs, selectClientFiles, touchesServer } from './run-ci-lint.js';

describe('CI client lint runner', () => {
  it('lints the whole client src tree in full mode', () => {
    expect(buildLintArgs({ mode: 'full' })).toEqual(['lint', '--error-on-warnings', 'src']);
  });

  it('lints only the changed files in files mode, tolerating unmatched paths', () => {
    expect(buildLintArgs({
      mode: 'files',
      clientFiles: ['src/pages/Dashboard.jsx', 'src/lib/uuid.js'],
    })).toEqual([
      'lint',
      '--error-on-warnings',
      '--no-errors-on-unmatched',
      'src/pages/Dashboard.jsx',
      'src/lib/uuid.js',
    ]);
  });

  it('keeps only client/src JavaScript, stripping the workspace prefix', () => {
    expect(selectClientFiles([
      'client/src/pages/Dashboard.jsx',
      'client/src/lib/uuid.js',
      'client/src/components/Deep/Nested.JSX',
      'server/services/backup.js',
      'client/vite.config.js',
      'client/src/styles.css',
      'client/src/types.ts',
      'docs/DEPS.md',
    ])).toEqual([
      'src/pages/Dashboard.jsx',
      'src/lib/uuid.js',
      'src/components/Deep/Nested.JSX',
    ]);
  });

  it('supports exactly the two documented modes', () => {
    expect(LINT_MODES).toEqual(['files', 'full']);
  });

  // Regression guard for the ESLint -> Biome migration: the runner must not go
  // looking for the removed eslint bin, and must not pass eslint-only flags
  // (`--ext` is not a Biome flag and makes it exit non-zero).
  it('invokes biome, not eslint', () => {
    expect(BIOME_BIN).toContain('@biomejs');
    expect(BIOME_BIN).not.toContain('eslint');
    for (const mode of LINT_MODES) {
      const args = buildLintArgs({ mode, clientFiles: ['src/a.js'] });
      expect(args).not.toContain('--ext');
      expect(args[0]).toBe('lint');
    }
  });

  // The server has no other static check: a removed declaration (the `d is not
  // defined` storyboard crash) only fails when a test happens to run that line.
  it('lints the server tree and only selects the job for server code or its config', () => {
    expect(SERVER_LINT_ARGS).not.toContain('--error-on-warnings');
    expect(touchesServer(['server/services/a.js', 'docs/x.md'])).toBe(true);
    expect(touchesServer(['server/biome.jsonc'])).toBe(true);
    expect(touchesServer(['server/node_modules/x/index.js', 'client/src/a.js', 'server/README.md'])).toBe(false);
  });

  // Vitest's HTML reporter writes JS assets under server/coverage/; lint must
  // ignore them while still failing on an undeclared identifier in real source.
  it.skipIf(!existsSync(BIOME_BIN))('ignores generated coverage assets but still flags undeclared variables in source', () => {
    const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'server');
    const dir = mkdtempSync(join(tmpdir(), 'biome-cov-'));
    try {
      cpSync(join(serverDir, 'biome.jsonc'), join(dir, 'biome.jsonc'));
      mkdirSync(join(dir, 'coverage'));
      writeFileSync(join(dir, 'coverage', 'prettify.js'), 'PR.prettyPrint();\n');
      const lint = () => spawnSync(process.execPath, [BIOME_BIN, 'lint', '.'], { cwd: dir, encoding: 'utf8' });
      expect(lint().status).toBe(0);
      writeFileSync(join(dir, 'app.js'), 'undeclaredThing();\n');
      expect(lint().status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
