import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ACTIONLINT_SHA256_LINUX_AMD64, ACTIONLINT_VERSION, parseActionlintVersion, probeActionlint, selectWorkflowFiles } from './lib/actionlint.js';
import { resolveTargets } from './run-actionlint.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('pinned actionlint', () => {
  it('mirrors its version and linux/amd64 archive SHA-256 literally in the CI lint job', () => {
    const ci = readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain(`ACTIONLINT_VERSION: ${ACTIONLINT_VERSION}`);
    expect(ci).toContain(`ACTIONLINT_SHA256_LINUX_AMD64: ${ACTIONLINT_SHA256_LINUX_AMD64}`);
  });

  it('parses the bare version from the first line of `actionlint -version`', () => {
    expect(parseActionlintVersion('1.7.12\nabc123\nbuilt with go1.26.3 compiler\n')).toBe('1.7.12');
    expect(parseActionlintVersion('')).toBeNull();
    expect(parseActionlintVersion('actionlint: command not found')).toBeNull();
  });

  // The probe decides whether pregate offers the stage or reports it as not
  // covered, so each unavailable state needs its own reason.
  it('is unavailable with a reason when no binary answers, or a different version does', () => {
    const none = probeActionlint({ env: {}, run: () => null });
    expect(none.ok).toBe(false);
    expect(none.reason).toMatch(/need 1\.7\.12/);

    const other = probeActionlint({ env: {}, run: (cmd) => (cmd === 'actionlint' ? '1.6.0\n' : '0.11.0') });
    expect(other).toMatchObject({ ok: false, reason: 'found actionlint 1.6.0, not the pinned 1.7.12' });
  });

  it('is unavailable when shellcheck is missing, since its shell checks would silently not run', () => {
    const run = (cmd) => (cmd === 'actionlint' ? `${ACTIONLINT_VERSION}\n` : null);
    expect(probeActionlint({ env: {}, run })).toMatchObject({ ok: false, reason: expect.stringMatching(/shellcheck is not on PATH/) });
  });

  it('is available from ACTIONLINT_BIN when it reports the pinned version and shellcheck exists', () => {
    const seen = [];
    const run = (cmd) => {
      seen.push(cmd);
      return cmd === '/opt/tools/actionlint' ? `${ACTIONLINT_VERSION}\n` : '0.11.0\n';
    };
    expect(probeActionlint({ env: { ACTIONLINT_BIN: '/opt/tools/actionlint' }, run }))
      .toEqual({ ok: true, bin: '/opt/tools/actionlint', version: ACTIONLINT_VERSION });
    expect(seen).toEqual(['/opt/tools/actionlint', 'shellcheck']);
  });
});

describe('workflow file selection', () => {
  it('keeps only top-level workflow YAML, never other .github files or nested paths', () => {
    expect(selectWorkflowFiles([
      '.github/workflows/ci.yml',
      '.github/workflows/release.yml',
      '.github/workflows/nested/x.yml',
      '.github/dependabot.yml',
      'docs/workflows/ci.yml',
      'scripts/run-actionlint.js',
    ])).toEqual(['.github/workflows/ci.yml', '.github/workflows/release.yml']);
  });

  it('lints every committed workflow in full mode and only the changed ones in files mode', () => {
    const full = resolveTargets({ env: { CI_LINT_MODE: 'full' } });
    expect(full).toEqual(expect.arrayContaining(['.github/workflows/ci.yml', '.github/workflows/release.yml']));
    expect(full.every((path) => path.startsWith('.github/workflows/'))).toBe(true);

    expect(resolveTargets({ env: { CI_LINT_MODE: 'files', CI_LINT_FILES: JSON.stringify(['client/src/App.jsx', '.github/workflows/ci.yml']) } }))
      .toEqual(['.github/workflows/ci.yml']);
  });

  it('takes explicit paths relative to the working directory, for the known-bad fixture proof', () => {
    expect(resolveTargets({ argv: ['scripts/fixtures/actionlint/runner-context-in-job-env.yml'], cwd: REPO_ROOT, env: { CI_LINT_MODE: 'full' } }))
      .toEqual(['scripts/fixtures/actionlint/runner-context-in-job-env.yml']);
  });
});
