import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { workflowJobs } from './lib/workflowJobs.js';

const script = fileURLToPath(new URL('./ci-install-containment-tools.sh', import.meta.url));

function run({ mode = 'available', testStatus = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-containment-tools-'));
  const bin = join(dir, 'bin');
  const log = join(dir, 'calls.log');
  mkdirSync(bin);
  const fake = (name, body) => writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  fake('sudo', 'exec "$@"');
  fake('timeout', '[[ "$1" = --kill-after=5 ]] || exit 2\nshift 2\nexec "$@"');
  fake('bwrap', '[[ "$1" = --version ]]');
  fake('dpkg-query', `if [[ '${mode}' = missing-package ]]; then echo 'deinstall ok config-files'; else echo 'install ok installed'; fi`);
  fake('apt-get', `
echo "apt-get $*" >> '${log}'
if [[ " $* " = *" update "* ]]; then
  count_file='${dir}/updates'
  count=0
  [[ ! -f "$count_file" ]] || read -r count < "$count_file"
  count=$((count + 1))
  echo "$count" > "$count_file"
  case '${mode}' in
    available) if [[ "$count" -eq 1 ]]; then echo 'Temporary failure resolving azure.archive.ubuntu.com' >&2; exit 100; fi ;;
    exhausted) echo 'Temporary failure resolving azure.archive.ubuntu.com' >&2; exit 100 ;;
    other-error) echo 'The repository is not signed.' >&2; exit 100 ;;
  esac
fi
`);
  const testCommand = join(bin, 'containment-test');
  writeFileSync(testCommand, `#!/bin/bash\necho "test $*" >> '${log}'\nexit ${testStatus}\n`, { mode: 0o755 });
  const result = spawnSync('/bin/bash', [script, testCommand, 'suite-arg'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, APT_UPDATE_TIMEOUT_SECONDS: '2', APT_INSTALL_TIMEOUT_SECONDS: '2' },
  });
  const calls = readFileSync(log, 'utf8').trim().split('\n');
  rmSync(dir, { recursive: true, force: true });
  return { ...result, calls };
}

describe.skipIf(process.platform === 'win32')('CI Linux containment prerequisite', () => {
  it('recovers exactly once from temporary mirror DNS failure and runs containment tests', () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('APT index update attempt 1/2');
    expect(result.stdout).toContain('APT index update attempt 2/2');
    expect(result.calls.filter((call) => call.includes(' update '))).toHaveLength(2);
    expect(result.calls.at(-2)).toContain('apt-get install -y bubblewrap');
    expect(result.calls.at(-1)).toBe('test suite-arg');
  });

  it('fails closed after the one DNS recovery attempt without installing or testing', () => {
    const result = run({ mode: 'exhausted' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('still failed after one temporary-DNS recovery attempt');
    expect(result.calls.filter((call) => call.includes(' update '))).toHaveLength(2);
    expect(result.calls.some((call) => call.includes('install -y bubblewrap'))).toBe(false);
    expect(result.calls.some((call) => call.startsWith('test '))).toBe(false);
  });

  it('does not retry unrelated APT failures', () => {
    const result = run({ mode: 'other-error' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('failed without a temporary DNS resolution error');
    expect(result.calls.filter((call) => call.includes(' update '))).toHaveLength(1);
    expect(result.calls.some((call) => call.includes('install -y bubblewrap'))).toBe(false);
  });

  it('does not run containment tests unless dpkg confirms bubblewrap is installed', () => {
    const result = run({ mode: 'missing-package' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('dpkg does not report bubblewrap installed');
    expect(result.calls.some((call) => call.startsWith('test '))).toBe(false);
  });

  it('does not retry a failure from the actual containment test command', () => {
    const result = run({ testStatus: 23 });
    expect(result.status).toBe(23);
    expect(result.calls.filter((call) => call.includes(' update '))).toHaveLength(2);
    expect(result.calls.filter((call) => call.startsWith('test '))).toHaveLength(1);
  });

  it('keeps the native Linux job gated on the same containment suites', () => {
    const workflow = readFileSync(fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url)), 'utf8');
    const job = workflowJobs(workflow)['linux-containment'];
    expect(job).toContain('run: bash scripts/ci-install-containment-tools.sh npm test --prefix server -- --run');
    for (const test of [
      '../autofixer/sandbox.verify.test.js',
      'lib/codeAnimationContainment.test.js',
      'routes/codeAnimationExecution.test.js',
      'services/codeAnimation/containedWorker.test.js',
      '../scripts/ci-install-containment-tools.test.js',
    ]) expect(job).toContain(test);
    expect(job).not.toContain('sudo apt-get');
  });
});
