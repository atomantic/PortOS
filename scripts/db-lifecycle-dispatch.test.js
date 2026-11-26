// Runs the real scripts/db.sh start/stop dispatch against stubbed executables in
// a temporary root (#10888). The server pins a native lifecycle request with a
// child-only PGMODE=native + canonical native endpoint; these cases prove db.sh
// then selects only native operations even though the saved/inherited active
// backend is Docker, and that the saved configuration is never rewritten. No
// real database or container is touched: docker, psql, pg_isready and uname
// are stubs placed ahead of the system directories on PATH.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const LOGGING_STUB = (name) => `#!/bin/sh
echo "${name} $*" >> "$STUB_LOG"
exit 0
`;

function writeStub(binDir, name, body) {
  const path = join(binDir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

describe.skipIf(process.platform === 'win32')('scripts/db.sh start/stop backend dispatch', () => {
  let root;
  let stubLog;
  let envFile;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'portos-db-lifecycle-'));
    mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
    copyFileSync(join(here, 'lib', 'envFile.cjs'), join(root, 'scripts', 'lib', 'envFile.cjs'));
    copyFileSync(join(here, 'lib', 'databaseSettings.cjs'), join(root, 'scripts', 'lib', 'databaseSettings.cjs'));
    copyFileSync(join(here, 'lib', 'readDbCliConfig.cjs'), join(root, 'scripts', 'lib', 'readDbCliConfig.cjs'));
    copyFileSync(join(here, 'db.sh'), join(root, 'scripts', 'db.sh'));
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    const binDir = join(root, 'bin');
    mkdirSync(binDir);
    symlinkSync(process.execPath, join(binDir, 'node'));
    for (const name of ['docker', 'psql', 'systemctl', 'sudo', 'pg_ctl']) writeStub(binDir, name, LOGGING_STUB(name));
    // Defaults to "accepting connections"; STUB_ISREADY_RC=2 simulates a down endpoint.
    writeStub(binDir, 'pg_isready', `#!/bin/sh
echo "pg_isready $*" >> "$STUB_LOG"
exit "\${STUB_ISREADY_RC:-0}"
`);
    // Not Darwin, so db.sh skips prepending a real Homebrew Postgres to PATH.
    writeStub(binDir, 'uname', '#!/bin/sh\necho "${STUB_UNAME:-Linux}"\n');
    stubLog = join(root, 'stub.log');
    envFile = join(root, '.env');
    writeFileSync(envFile, 'PGMODE=docker\n');
    writeFileSync(stubLog, '');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const run = (action, overrides) => spawnSync('bash', [join(root, 'scripts', 'db.sh'), action], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: `${join(root, 'bin')}:/usr/bin:/bin`,
      HOME: root,
      STUB_LOG: stubLog,
      // The active backend as the running server process sees it.
      PGMODE: 'docker',
      PGPORT: '5561',
      PGHOST: 'localhost',
      PGPASSWORD: 'test-only',
      PORTOS_BREW_PG_PREFIXES: join(root, 'no-brew-prefix'),
      ...overrides,
    },
  });

  // The child environment dbAdmin builds for a native request.
  const NATIVE_CHILD = { PGMODE: 'native', PGHOST: 'localhost', PGPORT: '5432' };

  it('starts only native, probing the native port, when Docker is the active backend', () => {
    const result = run('start', NATIVE_CHILD);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Starting native PostgreSQL');
    const log = readFileSync(stubLog, 'utf8');
    expect(log).not.toMatch(/^docker /m);
    expect(log).toMatch(/^pg_isready .*-p 5432\b/m);
    expect(log).not.toMatch(/-p 5561\b/);
    expect(readFileSync(envFile, 'utf8')).toBe('PGMODE=docker\n');
  });

  it('stops only native when Docker is the active backend', () => {
    const result = run('stop', { ...NATIVE_CHILD, STUB_ISREADY_RC: '2' });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Stopping native PostgreSQL');
    expect(readFileSync(stubLog, 'utf8')).not.toMatch(/^docker /m);
    expect(readFileSync(envFile, 'utf8')).toBe('PGMODE=docker\n');
  });

  // Negative control: the unpinned child (the pre-fix call) follows the active
  // Docker backend, which is exactly the wrong-resource stop the pin prevents.
  it('without the pin, stop follows the active Docker backend', () => {
    const result = run('stop');

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Stopping Docker PostgreSQL');
    expect(readFileSync(stubLog, 'utf8')).toMatch(/^docker compose stop db$/m);
  });

  // #10889: a failed stop must not read as "Stopped" with exit 0.
  it('fails Docker stop when `docker compose stop db` fails', () => {
    writeStub(join(root, 'bin'), 'docker', '#!/bin/sh\necho "docker $*" >> "$STUB_LOG"\n[ "$1 $2" = "compose stop" ] && { echo "daemon unreachable" >&2; exit 1; }\nexit 0\n');

    const result = run('stop');

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('Stopped');
    expect(result.stderr + result.stdout).toContain('daemon unreachable');
  });

  it('fails native stop while the endpoint still accepts connections', () => {
    const result = run('stop', { ...NATIVE_CHILD, STUB_ISREADY_RC: '0' });

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toMatch(/Stopped\b/);
    expect(result.stdout).toContain('still accepting connections');
  });

  it('keeps native stop idempotent when the endpoint is already down', () => {
    const result = run('stop', { ...NATIVE_CHILD, STUB_ISREADY_RC: '2' });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Stopped');
  });
  // Stateful isready: accepting until the named stop command has been logged.
  const readyUntilStopped = (binDir, stopPattern) => writeStub(binDir, 'pg_isready', `#!/bin/sh
echo "pg_isready $*" >> "$STUB_LOG"
if grep -q '${stopPattern}' "$STUB_LOG"; then exit 2; fi
exit 0
`);

  it('macOS stop falls back to pg_ctl when brew services leaves the endpoint up', () => {
    const binDir = join(root, 'bin');
    const datadir = join(root, 'brewprefix', 'var', 'postgresql@17');
    mkdirSync(datadir, { recursive: true });
    writeStub(binDir, 'brew', `#!/bin/sh
echo "brew $*" >> "$STUB_LOG"
[ "$1" = "--prefix" ] && echo "${join(root, 'brewprefix')}"
exit 0
`);
    readyUntilStopped(binDir, 'pg_ctl -D .* stop -m fast');

    const result = run('stop', { ...NATIVE_CHILD, STUB_UNAME: 'Darwin' });

    expect(result.status, result.stdout + result.stderr).toBe(0);
    const log = readFileSync(stubLog, 'utf8');
    expect(log).toContain('brew services stop postgresql@17');
    expect(log).toContain(`pg_ctl -D ${datadir} stop -m fast`);
  });

  it('Linux stop dispatches systemctl while the endpoint is accepting', () => {
    readyUntilStopped(join(root, 'bin'), 'systemctl stop postgresql');

    const result = run('stop', NATIVE_CHILD);

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readFileSync(stubLog, 'utf8')).toMatch(/systemctl stop postgresql/);
  });

  it('Linux start dispatches systemctl and prints no brew hint when it fails', () => {
    writeStub(join(root, 'bin'), 'pg_isready', '#!/bin/sh\nexit 2\n');

    const result = run('start', { ...NATIVE_CHILD, PGDATA: join(root, 'missing') });

    expect(result.status).not.toBe(0);
    expect(readFileSync(stubLog, 'utf8')).toMatch(/systemctl start postgresql/);
    expect(result.stdout + result.stderr).toContain('systemctl start postgresql');
    expect(result.stdout + result.stderr).not.toContain('brew services');
  });

  it('setup-native matches database names exactly so portos-staging does not hide portos', () => {
    // Stub psql answers existence probes by exact match against a sibling-only set.
    writeStub(join(root, 'bin'), 'psql', `#!/bin/sh
input="$(cat)"
echo "psql $*" >> "$STUB_LOG"
printf '%s\\n' "$input" >> "$STUB_LOG"
case "$input" in
  *pg_database*) [ "$PORTOS_BOOTSTRAP_DB" = "portos-staging" ] && echo 1 ;;
  *pg_roles*) echo 1 ;;
esac
exit 0
`);
    const result = run('setup-native', { ...NATIVE_CHILD, PGDATABASE: 'portos', PGUSER: 'portos' });

    const log = readFileSync(stubLog, 'utf8');
    expect(result.stdout).toContain('Creating database: portos');
    expect(log).toContain('CREATE DATABASE :"db" OWNER :"role";');
  });
});
