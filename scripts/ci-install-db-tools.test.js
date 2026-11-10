import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { workflowJobs } from './lib/workflowJobs.js';

const script = fileURLToPath(new URL('./ci-install-db-tools.sh', import.meta.url));
const PACKAGE_FILE = 'libcodec2_1_amd64.deb';
const PACKAGE_BYTES = 'verified package';
const PACKAGE_HASH = createHash('sha256').update(PACKAGE_BYTES).digest('hex');

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
function run(mirror, cache) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-db-tools-'));
  const bin = join(dir, 'bin');
  const root = join(dir, 'root');
  const sourcesFile = join(root, 'etc/apt/sources.list.d/ubuntu.sources');
  const log = join(dir, 'calls');
  const githubPath = join(dir, 'github_path');
  const clock = join(dir, 'clock');
  const bashEnv = join(dir, 'bash-env');
  const archives = join(root, 'var/cache/apt/archives');
  const packageCache = join(dir, 'package-cache');
  writeFileSync(clock, '0\n');
  // Unsetting Bash's special SECONDS turns it into an ordinary variable.
  // DEBUG/functrace refresh it before commands inside bounded() too.
  writeFileSync(bashEnv, `unset SECONDS\nSECONDS=0\nset -T\ntrap 'read -r SECONDS < "$TEST_CLOCK"' DEBUG\n`);
  mkdirSync(bin);
  mkdirSync(archives, { recursive: true });
  mkdirSync(packageCache);
  if (cache === 'warm' || cache === 'corrupt') {
    // Equal size catches the case apt's own existing-archive check accepts.
    writeFileSync(join(packageCache, PACKAGE_FILE), cache === 'warm' ? PACKAGE_BYTES : 'untrusted bytes!');
  }
  mkdirSync(join(root, 'etc/apt/sources.list.d'), { recursive: true });
  writeFileSync(join(root, 'etc/os-release'), 'VERSION_CODENAME=noble\n');
  writeFileSync(sourcesFile, RUNNER_SOURCES);
  const fake = (name, body) => writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  fake('sudo', 'exec "$@"');
  // Keep the production GNU sed invocation intact while adapting its in-place
  // flag only inside this synthetic command fixture on macOS.
  fake('sed', 'if [ "$(uname -s)" = Darwin ]; then\n  [ "$1" = "-i" ] && [ "$2" = "-E" ] || exit 2\n  shift 2\n  exec /usr/bin/sed -i "" -E "$@"\nfi\nexec /usr/bin/sed -i -E "$@"');
  fake('curl', 'while [ $# -gt 0 ]; do [ "$1" = -o ] && echo key > "$2"; shift; done');
  fake('sha256sum', 'if [ "$(uname -s)" = Darwin ]; then exec shasum -a 256 "$@"; fi\nexec /usr/bin/sha256sum "$@"');
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
  fake('apt-get', `
echo "apt-get $*" >> '${log}'
if ${stall}; then exit 124; fi
if [[ " $* " = *" --print-uris "* ]]; then
  echo "'https://example.com/${PACKAGE_FILE}' ${PACKAGE_FILE} ${PACKAGE_BYTES.length} SHA256:${PACKAGE_HASH}"
elif [[ " $* " = *" --download-only "* ]]; then
  if [[ ! -f '${archives}/${PACKAGE_FILE}' ]]; then
    echo 'download ${PACKAGE_FILE}' >> '${log}'
    printf '%s' '${PACKAGE_BYTES}' > '${archives}/${PACKAGE_FILE}'
  fi
  mkdir -p '${archives}/partial'
  echo incomplete > '${archives}/partial/unfinished.deb'
elif [[ " $* " = *" --no-download "* ]]; then
  [[ "$(cat '${archives}/${PACKAGE_FILE}')" = '${PACKAGE_BYTES}' ]] || exit 1
fi`);

  const result = spawnSync('/bin/bash', [script], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      APT_ROOT: root,
      BASH_ENV: bashEnv,
      TEST_CLOCK: clock,
      PG_MAJOR: '17',
      GITHUB_PATH: githubPath,
      ...(cache ? { APT_PACKAGE_CACHE: packageCache } : {}),
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
    downloaded: read(log).includes(`download ${PACKAGE_FILE}`),
    cachedPackage: read(join(packageCache, PACKAGE_FILE)),
    cachedPartial: existsSync(join(packageCache, 'unfinished.deb')),
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
    const result = run('slowRunner', 'cold');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('switching to https://archive.ubuntu.com/ubuntu/');
    expect(result.sources).toBe(RUNNER_SOURCES.replace('http://azure.archive.ubuntu.com/ubuntu/', 'https://archive.ubuntu.com/ubuntu/'));
    expect(result.calls).toEqual([
      'apt-get update',
      'apt-get update',
      'apt-get --print-uris install -y postgresql-client-17 ffmpeg',
      'apt-get install -y --download-only postgresql-client-17 ffmpeg',
      INSTALL_FROM_CACHE,
    ]);
    // The primary stall spends 180s of fake time, leaving 210s of the one
    // total deadline for all fallback commands (no per-command reset).
    expect(result.budgets).toEqual([180, 210, 210, 210]);
    expect(result.githubPath).toBe('/usr/lib/postgresql/17/bin\n');
  });

  it('fails as an installation failure once the whole budget is spent', () => {
    const result = run('dead', 'warm');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('::error title=DB tool installation failed::');
    expect(result.stderr).toContain('within 390s');
    expect(result.budgets).toEqual([180, 210]);
    expect(result.calls).not.toContain(INSTALL_FROM_CACHE);
    expect(result.githubPath).toBe('');
  });

  it('saves complete downloads on a cold cache and reuses verified bytes on a warm cache', () => {
    const cold = run('ok', 'cold');
    expect(cold.status, cold.stderr).toBe(0);
    expect(cold.downloaded).toBe(true);
    expect(cold.cachedPackage).toBe(PACKAGE_BYTES);
    expect(cold.cachedPartial).toBe(false);

    const warm = run('ok', 'warm');
    expect(warm.status, warm.stderr).toBe(0);
    expect(warm.downloaded).toBe(false);
    expect(warm.stdout).toContain(`Reused verified APT package ${PACKAGE_FILE}`);
    expect(warm.calls).toEqual([
      'apt-get update',
      'apt-get --print-uris install -y postgresql-client-17 ffmpeg',
      'apt-get install -y --download-only postgresql-client-17 ffmpeg',
      INSTALL_FROM_CACHE,
    ]);
    expect(warm.budgets).toEqual([180, 180, 180]);
    expect(warm.pgdg).toContain('[signed-by=');
  });

  it('downloads a replacement for a same-size cache entry that fails signed-index hash verification', () => {
    const result = run('ok', 'corrupt');
    expect(result.status, result.stderr).toBe(0);
    expect(result.downloaded).toBe(true);
    expect(result.stdout).toContain('Ignoring invalid cached APT package');
    expect(result.cachedPackage).toBe(PACKAGE_BYTES);
  });

  it('installs the client major of the DB job\'s PostgreSQL service', () => {
    const workflow = readFileSync(fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url)), 'utf8');
    const serviceMajor = workflow.match(/image: pgvector\/pgvector:pg(\d+)@/)?.[1];
    expect(serviceMajor).toBeTruthy();
    const jobs = workflowJobs(workflow);
    for (const id of ['database', 'browser']) {
      const body = jobs[id];
      const identify = body.split('- name: Identify APT package cache\n')[1].split('\n      - name:')[0];
      const cache = body.split('- name: Cache APT package downloads\n')[1].split('\n      - name:')[0];
      const install = body.split('- name: Install PostgreSQL client and audio verification tools\n')[1].split('\n      - name:')[0];
      expect(identify).toContain(`PG_MAJOR: '${serviceMajor}'`);
      expect(install).toContain(`PG_MAJOR: '${serviceMajor}'`);
      expect(identify).toContain('. /etc/os-release');
      expect(identify).toContain('prefix="apt-debs-v1-${ID}-${VERSION_ID}-$(dpkg --print-architecture)-pg${PG_MAJOR}-${{ hashFiles(\'scripts/ci-install-db-tools.sh\') }}-"');
      expect(identify).toContain('echo "prefix=$prefix" >> "$GITHUB_OUTPUT"');
      expect(identify).toContain('echo "key=${prefix}$(date -u +%Y%m%d)" >> "$GITHUB_OUTPUT"');
      expect(cache).toContain('uses: actions/cache@');
      expect(cache).toContain('path: ${{ runner.temp }}/portos-apt-packages/*.deb');
      expect(cache).toContain('key: ${{ steps.apt-cache.outputs.key }}');
      expect(cache).toContain('restore-keys: ${{ steps.apt-cache.outputs.prefix }}');
      expect(install).toContain('APT_PACKAGE_CACHE: ${{ runner.temp }}/portos-apt-packages');
      expect(install).toContain('run: bash scripts/ci-install-db-tools.sh');
      expect(install).not.toContain('if:');
      expect(body.indexOf('- name: Cache APT package downloads')).toBeLessThan(body.indexOf('- name: Install PostgreSQL client'));
    }
  });
});
