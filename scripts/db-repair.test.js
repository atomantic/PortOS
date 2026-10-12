// Exercise the real repair/start dispatch with synthetic files and Docker
// executables. No daemon, PostgreSQL endpoint or real data volume is accessed.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const image = readFileSync(join(here, '..', 'docker-compose.yml'), 'utf8').match(/image: (\S+)/)[1];

function executable(path, content) {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

describe.skipIf(process.platform === 'win32')('database Docker repair safety', () => {
  let root;
  let lock;
  let logFile;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'portos-db-repair-'));
    mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
    mkdirSync(join(root, 'bin'));
    mkdirSync(join(root, 'volume'));
    copyFileSync(join(here, 'db.sh'), join(root, 'scripts', 'db.sh'));
    copyFileSync(join(here, 'lib', 'envFile.cjs'), join(root, 'scripts', 'lib', 'envFile.cjs'));
    copyFileSync(join(here, 'lib', 'databaseSettings.cjs'), join(root, 'scripts', 'lib', 'databaseSettings.cjs'));
    copyFileSync(join(here, '..', 'docker-compose.yml'), join(root, 'docker-compose.yml'));
    symlinkSync(process.execPath, join(root, 'bin', 'node'));
    executable(join(root, 'bin', 'uname'), '#!/bin/sh\necho Linux\n');
    executable(join(root, 'bin', 'sleep'), '#!/bin/sh\nexit 0\n');
    executable(join(root, 'bin', 'docker'), `#!/bin/bash
set -eu
echo "docker $*" >> "$STUB_LOG"
case "$1 \${2:-}" in
  'info '|'compose version') exit 0 ;;
  'ps -aq')
    [ "\${STUB_LIST_FAIL:-0}" = 0 ] || exit 20
    if [ ! -f "$STUB_ROOT/removed" ] && [ "\${STUB_ABSENT:-0}" = 0 ]; then echo fixture-db; fi ;;
  'inspect -f')
    if [[ "$3" == *State.Running* ]]; then
      [ "\${STUB_STATE_FAIL:-0}" = 0 ] || exit 21
      echo "\${STUB_RUNNING:-false}"
    else echo fixture-recorded-volume; fi ;;
  'compose stop') exit "\${STUB_STOP_RC:-0}" ;;
  'rm fixture-db')
    [ "\${STUB_RM_RC:-0}" = 0 ] || exit "$STUB_RM_RC"
    touch "$STUB_ROOT/removed" ;;
  'volume inspect') exit "\${STUB_VOLUME_RC:-0}" ;;
  'compose config')
    if [ "$3" = --images ]; then echo "$STUB_IMAGE";
    else echo '{"services":{"db":{"volumes":[{"type":"volume","source":"db-data","target":"/var/lib/postgresql/data"}]}},"volumes":{"db-data":{"name":"fixture-configured-volume"}}}'; fi ;;
  'run --rm')
    [ "\${STUB_HELPER_RC:-0}" = 0 ] || exit "$STUB_HELPER_RC"
    # Execute the actual helper command against the fixture directory. A no-op
    # rm simulates a lock that survives; the helper must verify its absence.
    command="\${!#}"
    command="\${command//\\/data/$STUB_ROOT/volume}"
    if [ "\${STUB_LOCK_PERSISTS:-0}" = 1 ]; then
      function rm() { return 0; }
      export -f rm
    fi
    bash -c "$command" ;;
  'compose up') touch "$STUB_ROOT/started" ;;
  'compose exec')
    if [ "$5" = pg_isready ]; then
      [ -f "$STUB_ROOT/removed" ] && [ "\${STUB_NEVER_READY:-0}" = 0 ] || exit 1
    else echo 1; fi ;;
  'logs portos-db') echo 'bogus data in lock file' ;;
  *) echo 'Unexpected Docker call' >&2; exit 99 ;;
esac
`);
    lock = join(root, 'volume', 'postmaster.pid');
    logFile = join(root, 'docker.log');
    writeFileSync(lock, 'synthetic lock');
    writeFileSync(logFile, '');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const run = (overrides = {}, action = 'fix') => spawnSync('bash', [join(root, 'scripts', 'db.sh'), action], {
    encoding: 'utf8',
    timeout: 10000,
    env: {
      PATH: `${join(root, 'bin')}:/usr/bin:/bin`,
      HOME: root,
      PGMODE: 'docker',
      STUB_ROOT: root,
      STUB_LOG: logFile,
      STUB_IMAGE: image,
      ...overrides,
    },
  });
  const log = () => readFileSync(logFile, 'utf8');

  it.each([
    ['failed shutdown', { STUB_STOP_RC: '17', STUB_RUNNING: 'true' }],
    ['failed removal', { STUB_RM_RC: '18' }],
    ['container still running after a successful stop', { STUB_RUNNING: 'true' }],
    ['unanswered state inspection', { STUB_STATE_FAIL: '1' }],
    ['unanswered container listing', { STUB_LIST_FAIL: '1' }],
    ['unverified volume', { STUB_VOLUME_RC: '1' }],
  ])('refuses lock deletion after %s', (_, overrides) => {
    const result = run(overrides);
    expect(result.status, result.stderr).not.toBe(0);
    expect(existsSync(lock)).toBe(true);
    expect(log()).not.toMatch(/^docker run /m);
    expect(result.stdout).not.toContain('Stale lock files cleaned');
  });

  it.each([
    ['helper command failure', { STUB_HELPER_RC: '19' }],
    ['lock remains after removal', { STUB_LOCK_PERSISTS: '1' }],
  ])('propagates %s without reporting cleanup success', (_, overrides) => {
    const result = run(overrides);
    expect(result.status, result.stderr).not.toBe(0);
    expect(existsSync(lock)).toBe(true);
    expect(log()).toMatch(/^docker run /m);
    expect(result.stdout).not.toContain('Stale lock files cleaned');
  });

  it.each([
    ['stopped container', {}, 'fixture-recorded-volume'],
    ['absent container', { STUB_ABSENT: '1' }, 'fixture-configured-volume'],
  ])('repairs a verified %s using its exact volume and cached pinned image', (_, overrides, volume) => {
    const result = run(overrides);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(lock)).toBe(false);
    expect(log()).toContain(`docker run --rm --pull=never -v ${volume}:/data ${image} sh -c`);
    expect(result.stdout).toContain('Stale lock files cleaned');
    if (overrides.STUB_ABSENT) expect(log()).not.toMatch(/^docker (rm|compose stop) /m);
  });

  it('automatically repairs once and retries startup successfully', () => {
    const result = run({}, 'start');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('PostgreSQL ready');
    expect(log().match(/^docker run /gm)).toHaveLength(1);
    expect(log().match(/^docker compose up /gm)).toHaveLength(2);
  });

  it('does not restart after failed automatic repair or repair again after a failed retry', () => {
    const failedRepair = run({ STUB_STOP_RC: '17' }, 'start');
    expect(failedRepair.status, failedRepair.stderr).not.toBe(0);
    expect(log().match(/^docker compose up /gm)).toHaveLength(1);
    expect(log()).not.toMatch(/^docker run /m);

    writeFileSync(logFile, '');
    const failedRetry = run({ STUB_NEVER_READY: '1' }, 'start');
    expect(failedRetry.status, failedRetry.stderr).not.toBe(0);
    expect(log().match(/^docker compose up /gm)).toHaveLength(2);
    expect(log().match(/^docker run /gm)).toHaveLength(1);
  });
});
