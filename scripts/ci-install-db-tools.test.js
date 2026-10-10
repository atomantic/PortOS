import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./ci-install-db-tools.sh', import.meta.url));

const RUNNER_SOURCES = `Types: deb
URIs: http://azure.archive.ubuntu.com/ubuntu/
Suites: noble noble-updates
Components: main universe
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: http://security.ubuntu.com/ubuntu/
Suites: noble-security
Components: main universe
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
`;

// Runs the real script against a fake filesystem root and a fake sudo/curl/
// apt-get/timeout on PATH; nothing touches the host's package manager or network.
// `mirror` decides how the fake apt-get behaves:
//   ok         — every source answers promptly
//   slowRunner — the watchdog expires while the Azure mirror is configured
//   dead       — the watchdog expires for every download
// Inject a Bash clock and watchdog instead of sleeping against 1–3 second
// budgets: startup/source rewriting consumed those budgets under load, and
// macOS does not ship GNU timeout. The real script still computes deadlines.
function run(mirror) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-db-tools-'));
  const bin = join(dir, 'bin');
  const root = join(dir, 'root');
  const sourcesFile = join(root, 'etc/apt/sources.list.d/ubuntu.sources');
  const log = join(dir, 'calls');
  const githubPath = join(dir, 'github_path');
  const clock = join(dir, 'clock');
  const bashEnv = join(dir, 'bash-env');
  writeFileSync(clock, '0\n');
  // Unsetting Bash's special SECONDS turns it into an ordinary variable.
  // DEBUG/functrace refresh it before commands inside bounded() too.
  writeFileSync(bashEnv, `unset SECONDS\nSECONDS=0\nset -T\ntrap 'read -r SECONDS < "$TEST_CLOCK"' DEBUG\n`);
  mkdirSync(bin);
  mkdirSync(join(root, 'etc/apt/sources.list.d'), { recursive: true });
  writeFileSync(join(root, 'etc/os-release'), 'VERSION_CODENAME=noble\n');
  writeFileSync(sourcesFile, RUNNER_SOURCES);
  const fake = (name, body) => writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  fake('sudo', 'exec "$@"');
  // Keep the production GNU sed invocation intact while adapting its in-place
  // flag only inside this synthetic command fixture on macOS.
  fake('sed', 'if [ "$(uname -s)" = Darwin ]; then\n  [ "$1" = "-i" ] && [ "$2" = "-E" ] || exit 2\n  shift 2\n  exec /usr/bin/sed -i "" -E "$@"\nfi\nexec /usr/bin/sed -i -E "$@"');
  fake('curl', 'while [ $# -gt 0 ]; do [ "$1" = -o ] && echo key > "$2"; shift; done');
  const stall = { ok: 'false', slowRunner: `grep -q azure '${sourcesFile}'`, dead: 'true' }[mirror];
  fake('timeout', `
[ "$1" = --kill-after=10 ] || exit 2
shift
budget="$1"
echo "timeout $budget" >> '${log}'
[ "$1" -gt 0 ] || exit 2
shift
"$@"
status=$?
if [ "$status" = 124 ]; then
  read -r elapsed < "$TEST_CLOCK"
  echo "$((elapsed + budget))" > "$TEST_CLOCK"
fi
exit "$status"`);
  fake('apt-get', `echo "apt-get $*" >> '${log}'\nif ${stall}; then exit 124; fi`);

  const result = spawnSync('/bin/bash', [script], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      APT_ROOT: root,
      BASH_ENV: bashEnv,
      TEST_CLOCK: clock,
      PG_MAJOR: '17',
      GITHUB_PATH: githubPath,
    },
  });
  const read = (file) => readFileSync(file, { encoding: 'utf8', flag: 'a+' });
  const out = {
    ...result,
    budgets: read(log).split('\n').filter((line) => line.startsWith('timeout ')).map((line) => Number(line.split(' ')[1])),
    calls: read(log).split('\n').filter((line) => line.startsWith('apt-get ')).map((line) => line.replace(/ -o \S+/g, '')),
    sources: read(sourcesFile),
    pgdg: read(join(root, 'etc/apt/sources.list.d/pgdg.list')),
    githubPath: read(githubPath),
  };
  rmSync(dir, { recursive: true, force: true });
  return out;
}

const INSTALL_FROM_CACHE = 'apt-get install -y --no-download postgresql-client-17 ffmpeg';

describe.skipIf(process.platform === 'win32')('CI DB tool installation', () => {
  it('installs the service-major client from the signed PostgreSQL repository', () => {
    const result = run('ok');
    expect(result.status, result.stderr).toBe(0);
    expect(result.pgdg).toBe('deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt noble-pgdg main\n');
    expect(result.calls).toEqual([
      'apt-get update',
      'apt-get install -y --download-only postgresql-client-17 ffmpeg',
      INSTALL_FROM_CACHE,
    ]);
    expect(result.sources).toBe(RUNNER_SOURCES);
    expect(result.githubPath).toBe('/usr/lib/postgresql/17/bin\n');
  });

  it('recovers from a stalled runner mirror through the official archive, keeping signing', () => {
    const result = run('slowRunner');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('switching to http://archive.ubuntu.com/ubuntu/');
    expect(result.sources).toBe(RUNNER_SOURCES.replace('azure.archive.ubuntu.com', 'archive.ubuntu.com'));
    expect(result.calls).toEqual([
      'apt-get update',
      'apt-get update',
      'apt-get install -y --download-only postgresql-client-17 ffmpeg',
      INSTALL_FROM_CACHE,
    ]);
    // The primary stall spends 180s of fake time, leaving 210s of the one
    // total deadline for BOTH fallback commands (no per-command reset).
    expect(result.budgets).toEqual([180, 210, 210]);
    expect(result.githubPath).toBe('/usr/lib/postgresql/17/bin\n');
  });

  it('fails as an installation failure once the whole budget is spent', () => {
    const result = run('dead');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('::error title=DB tool installation failed::');
    expect(result.stderr).toContain('within 390s');
    expect(result.budgets).toEqual([180, 210]);
    expect(result.calls).not.toContain(INSTALL_FROM_CACHE);
    expect(result.githubPath).toBe('');
  });

  it('installs the client major of the DB job\'s PostgreSQL service', () => {
    const workflow = readFileSync(fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url)), 'utf8');
    const serviceMajor = workflow.match(/image: pgvector\/pgvector:pg(\d+)@/)?.[1];
    expect(serviceMajor).toBeTruthy();
    expect(workflow).toMatch(new RegExp(`PG_MAJOR: '${serviceMajor}'\\n\\s+run: bash scripts/ci-install-db-tools\\.sh`));
  });
});
