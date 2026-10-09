// Runs the real scripts/db.sh control flow against stubbed executables in a
// temporary root. Migration refuses before side effects; failed pg_dump never
// publishes a partial export (#8781). No real database is touched:
// every host command db.sh reaches (docker, psql, pg_dump, pg_isready, uname)
// is a stub placed ahead of the system directories on PATH.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const FULL_DUMP = 'DROP TABLE IF EXISTS example_record;\nCREATE TABLE example_record (id int);\n';

// One `docker` stub covers every Docker call db.sh makes in docker mode:
// `ps` (running check), `exec … pg_dump` (export), `exec -i … psql` (import),
// and `compose stop db` (source shutdown). DUMP_MODE picks the dump outcome.
const DOCKER_STUB = `#!/bin/sh
echo "docker $*" >> "$STUB_LOG"
case "$1" in
  ps) echo "Up 5 minutes"; exit 0 ;;
  info) exit 0 ;;
  compose)
    [ -n "$COMPOSE_ENV_LOG" ] && echo "$PGUSER|$PGDATABASE|$PGPASSWORD|$PGPORT_DOCKER" >> "$COMPOSE_ENV_LOG"
    case "$*" in *" stop "*) echo SOURCE_STOP >> "$STUB_LOG" ;; esac
    exit 0 ;;
  exec)
    case "$*" in
      *pg_dump*)
        case "$DUMP_MODE" in
          partial) printf 'DROP TABLE example_record;\\n'; exit 1 ;;
          empty) exit 1 ;;
          *) printf '%s' "$FULL_DUMP"; exit 0 ;;
        esac ;;
      *psql*)
        echo IMPORT >> "$STUB_LOG"
        # docker exec forwards stdin only when interactive mode is enabled.
        case " $* " in *" -i "*) cat >> "$IMPORT_LOG" ;; esac
        exit 0 ;;
    esac ;;
esac
exit 0
`;

const PSQL_STUB = `#!/bin/sh
echo "psql $*" >> "$STUB_LOG"
echo "endpoint-env \${PGHOSTADDR-unset}|\${PGSERVICE-unset}|\${PGSERVICEFILE-unset}|\${PGOPTIONS-unset}|tls=\${PGSSLMODE-unset}" >> "$STUB_LOG"
case "$*" in *--single-transaction*) cat >> "$IMPORT_LOG"; exit "\${IMPORT_EXIT:-0}" ;; esac
if [ -n "\${PORTOS_BOOTSTRAP_ROLE:-}" ]; then cat > "$ROLE_INPUT_LOG"; fi
case "$*" in *count*) echo 3 ;; esac
exit 0
`;

const PG_DUMP_STUB = `#!/bin/sh
echo "pg_dump $*" >> "$STUB_LOG"
echo "endpoint-env \${PGHOSTADDR-unset}|\${PGSERVICE-unset}|\${PGSERVICEFILE-unset}|\${PGOPTIONS-unset}|tls=\${PGSSLMODE-unset}" >> "$STUB_LOG"
case "$DUMP_MODE" in
  partial) printf 'DROP TABLE example_record;\\n'; exit 1 ;;
  empty) exit 1 ;;
  *) printf '%s' "$FULL_DUMP" ;;
esac
`;

// Logs each probe; READY_PORTS (space-separated) limits which ports answer, so a
// test can stand up "another cluster on the default port" without a real server.
const PG_ISREADY_STUB = `#!/bin/sh
echo "pg_isready $*" >> "$STUB_LOG"
echo "endpoint-env \${PGHOSTADDR-unset}|\${PGSERVICE-unset}|\${PGSERVICEFILE-unset}|\${PGOPTIONS-unset}|tls=\${PGSSLMODE-unset}" >> "$STUB_LOG"
port=""; prev=""
for arg in "$@"; do [ "$prev" = "-p" ] && port="$arg"; prev="$arg"; done
[ -z "\${READY_PORTS:-}" ] && exit 0
case " $READY_PORTS " in *" $port "*) exit 0 ;; esac
exit 1
`;

function writeStub(binDir, name, body) {
  const path = join(binDir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

describe.skipIf(process.platform === 'win32')('scripts/db.sh export + migrate', () => {
  let root;
  let stubLog;
  let importLog;
  let envFile;
  let dumpDir;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'portos-db-sh-'));
    mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
    copyFileSync(join(here, 'lib', 'envFile.cjs'), join(root, 'scripts', 'lib', 'envFile.cjs'));
    copyFileSync(join(here, 'db.sh'), join(root, 'scripts', 'db.sh'));
    copyFileSync(join(here, 'prepare-database-replay.mjs'), join(root, 'scripts', 'prepare-database-replay.mjs'));
    mkdirSync(join(root, 'server', 'services'), { recursive: true });
    copyFileSync(join(here, '../server/services/backupDatabaseDump.js'), join(root, 'server/services/backupDatabaseDump.js'));
    copyFileSync(join(here, '../server/services/databaseImport.js'), join(root, 'server/services/databaseImport.js'));
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    const binDir = join(root, 'bin');
    mkdirSync(binDir);
    symlinkSync(process.execPath, join(binDir, 'node'));
    writeStub(binDir, 'docker', DOCKER_STUB);
    writeStub(binDir, 'psql', PSQL_STUB);
    writeStub(binDir, 'pg_dump', PG_DUMP_STUB);
    writeStub(binDir, 'pg_isready', PG_ISREADY_STUB);
    // Not Darwin, so db.sh skips prepending Homebrew's real Postgres to PATH.
    writeStub(binDir, 'uname', '#!/bin/sh\necho Linux\n');
    writeStub(binDir, 'whoami', '#!/bin/sh\necho example_user\n');
    stubLog = join(root, 'stub.log');
    importLog = join(root, 'import.log');
    envFile = join(root, '.env');
    dumpDir = join(root, 'data', 'db-dumps');
    writeFileSync(envFile, 'PGMODE=docker\n');
    writeFileSync(stubLog, '');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const run = (args, dumpMode, overrides = {}) => spawnSync('bash', [join(root, 'scripts', 'db.sh'), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: `${join(root, 'bin')}:/usr/bin:/bin`,
      HOME: root,
      STUB_LOG: stubLog,
      IMPORT_LOG: importLog,
      ROLE_INPUT_LOG: join(root, 'role.sql'),
      DUMP_MODE: dumpMode,
      FULL_DUMP,
      PGPASSWORD: 'test-only',
      PGHOST: '127.0.0.1',
      ...overrides,
    }
  });

  const tempArtifacts = () => (existsSync(dumpDir) ? readdirSync(dumpDir).filter(f => f.startsWith('portos-export.')) : []);
  const dumps = () => (existsSync(dumpDir) ? readdirSync(dumpDir).filter(f => f.endsWith('.sql')) : []);

  it.each(['partial', 'empty'])('refuses to publish a %s failed export', (mode) => {
    const result = run(['export', 'failed'], mode);

    expect(result.status).not.toBe(0);
    const log = readFileSync(stubLog, 'utf8');
    expect(log).not.toContain('IMPORT');
    expect(log).not.toContain('SOURCE_STOP');
    expect(existsSync(importLog)).toBe(false);
    expect(readFileSync(envFile, 'utf8')).toBe('PGMODE=docker\n');
    expect(dumps()).toEqual([]);
    expect(tempArtifacts()).toEqual([]);
  });

  it('keeps an existing dump intact when a re-export under the same label fails', () => {
    mkdirSync(dumpDir, { recursive: true });
    const existing = join(dumpDir, 'portos-keep.sql');
    writeFileSync(existing, FULL_DUMP);

    const result = run(['export', 'keep'], 'partial');

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('portos-keep.sql');
    expect(readFileSync(existing, 'utf8')).toBe(FULL_DUMP);
    expect(tempArtifacts()).toEqual([]);
  });

  it('publishes a complete export without switching mode or stopping the source', () => {
    const result = run(['export', 'complete'], 'ok');
    expect(result.status).toBe(0);
    expect(readFileSync(join(dumpDir, 'portos-complete.sql'), 'utf8')).toBe(FULL_DUMP);
    expect(readFileSync(envFile, 'utf8')).toBe('PGMODE=docker\n');
    expect(readFileSync(stubLog, 'utf8')).not.toMatch(/IMPORT|SOURCE_STOP/);
    expect(tempArtifacts()).toEqual([]);
  });

  // Regression: the standalone CLI used defaults or a stale Docker database
  // while the application used the quoted native endpoint saved in .env.
  it('exports and imports the saved quoted native endpoint without evaluating shell text', () => {
    const password = "example $(touch SHOULD_NOT_EXIST) ' password";
    writeFileSync(envFile, `PGMODE = "native"\nPGHOST=db.example.invalid\nPGPORT=6543\nPGUSER=example_user\nPGDATABASE=example_db\nPGPASSWORD="${password}"\n`);
    const overrides = { PGHOST: undefined, PGPASSWORD: undefined };
    const exported = run(['export', 'saved'], 'ok', overrides);
    expect(exported.status, exported.stderr).toBe(0);
    const dump = join(dumpDir, 'portos-saved.sql');
    expect(run(['import', dump], 'ok', overrides).status).toBe(0);
    const log = readFileSync(stubLog, 'utf8');
    expect(log).toContain('pg_dump -h db.example.invalid -p 6543 -U example_user -d example_db');
    expect(log).toContain('psql -h db.example.invalid -p 6543 -U example_user -d example_db');
    expect(log).not.toContain('docker');
    expect(existsSync(join(root, 'SHOULD_NOT_EXIST'))).toBe(false);
    expect(readFileSync(importLog, 'utf8')).toBe(FULL_DUMP);
  });

  it('honors shell connection overrides without exporting the unrelated local Docker database', () => {
    writeFileSync(envFile, 'PGMODE=docker\nPGHOST=localhost\nPGPORT_DOCKER=5599\n');
    const exported = run(['export', 'override'], 'ok', {
      PGHOST: 'other.example.invalid', PGPORT: '6544', PGUSER: 'override_user', PGDATABASE: 'override_db',
    });
    expect(exported.status, exported.stderr).toBe(0);
    const log = readFileSync(stubLog, 'utf8');
    expect(log).toContain('pg_dump -h other.example.invalid -p 6544 -U override_user -d override_db');
    expect(log).not.toContain('docker');
  });

  it('fails before database commands when the configuration parser is missing', () => {
    rmSync(join(root, 'scripts', 'lib', 'envFile.cjs'));
    const result = run(['export', 'no-config'], 'ok');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Could not load database configuration');
    expect(readFileSync(stubLog, 'utf8')).toBe('');
    expect(dumps()).toEqual([]);
  });

  it('provisions the saved native endpoint even when Docker is the selected runtime', () => {
    writeFileSync(envFile, 'PGMODE=docker\nPGHOST=db.example.invalid\nPGPORT=5433\nPGPORT_DOCKER=5599\n');
    const result = run(['setup-native'], 'ok', { PGHOST: undefined, READY_PORTS: '5433' });
    expect(result.status, result.stderr).toBe(0);
    expect(psqlCalls().length).toBeGreaterThanOrEqual(6);
    expect(psqlCalls().every(call => call.includes('-h db.example.invalid -p 5433 '))).toBe(true);
  });

  it('uses the saved Docker port for host imports while retaining container-only exports', () => {
    writeFileSync(envFile, 'PGMODE="docker"\nPGPORT=5433\nPGPORT_DOCKER=5599\n');
    const exported = run(['export', 'docker-saved'], 'ok');
    expect(exported.status, exported.stderr).toBe(0);
    const dump = join(dumpDir, 'portos-docker-saved.sql');
    expect(run(['import', dump], 'ok').status).toBe(0);
    const log = readFileSync(stubLog, 'utf8');
    expect(log).toContain('portos-db pg_dump');
    expect(log).toContain('psql -h 127.0.0.1 -p 5599');
  });

  // Regression: saved Docker mode formerly overrode a caller's explicit host
  // port, so a coordinator could silently snapshot the wrong database.
  it.each(['docker', 'native'])('binds export and transactional import to explicit endpoints in saved %s mode', (mode) => {
    writeFileSync(envFile, `PGMODE=${mode}\n`);
    const source = ['--endpoint', 'source.example.invalid', '6543', 'example_user', 'example source'];
    const target = ['--endpoint', 'target.example.invalid', '6544', 'example_user', 'example target'];
    const inherited = { PGPORT: '9999', PGHOSTADDR: '192.0.2.10', PGSERVICE: 'other', PGSERVICEFILE: '/example/service.conf', PGOPTIONS: '-c search_path=other' };
    const exported = run(['export', ...source, 'explicit'], 'ok', inherited);
    expect(exported.status, exported.stderr).toBe(0);
    const dump = join(dumpDir, 'portos-explicit.sql');
    expect(exported.stdout.trim()).toBe(dump);
    expect(readFileSync(dump, 'utf8')).toBe(FULL_DUMP);
    writeFileSync(dump, `\\restrict example\nSET transaction_timeout = 0;\n${FULL_DUMP}\\unrestrict example\n`);
    const imported = run(['import', ...target, dump], 'ok', inherited);
    expect(imported.status, imported.stderr).toBe(0);
    expect(readFileSync(importLog, 'utf8')).toBe(FULL_DUMP);
    const log = readFileSync(stubLog, 'utf8');
    expect(log).toContain('pg_dump -h source.example.invalid -p 6543 -U example_user -d example source');
    expect(log).toContain('psql -h target.example.invalid -p 6544 -U example_user -d example target -v ON_ERROR_STOP=1 --single-transaction');
    expect(log).not.toMatch(/docker|SOURCE_STOP|test-only/);
    expect(log.match(/endpoint-env unset\|unset\|unset\|unset/g)).toHaveLength(2);
    expect(log).not.toContain('192.0.2.10');
    expect(readFileSync(envFile, 'utf8')).toBe(`PGMODE=${mode}\n`);
  });

  it('preserves the recovery dump and propagates explicit dump/import failures', () => {
    const endpoint = ['--endpoint', 'example.invalid', '6543', 'example', 'example_db'];
    mkdirSync(dumpDir, { recursive: true });
    const dump = join(dumpDir, 'portos-recovery.sql');
    writeFileSync(dump, FULL_DUMP);
    const exported = run(['export', ...endpoint, 'recovery'], 'partial');
    expect(exported.status).not.toBe(0);
    expect(exported.stdout).toBe('');
    expect(tempArtifacts()).toEqual([]);
    const imported = run(['import', ...endpoint, dump], 'ok', { IMPORT_EXIT: '7' });
    expect(imported.status).not.toBe(0);
    expect(imported.stdout).not.toContain('Import complete');
    expect(readFileSync(dump, 'utf8')).toBe(FULL_DUMP);
    expect(readFileSync(stubLog, 'utf8')).not.toMatch(/docker|SOURCE_STOP/);
  });

  it('fails closed when explicit host tools are missing instead of using Docker', () => {
    rmSync(join(root, 'bin', 'psql'));
    rmSync(join(root, 'bin', 'pg_dump'));
    // Isolate PATH completely so installed PostgreSQL cannot be reached.
    const commands = ['dirname', 'mkdir', 'mktemp', 'rm', 'sed', 'grep', 'cut', 'tr'];
    const isolated = join(root, 'isolated');
    mkdirSync(isolated);
    symlinkSync(process.execPath, join(isolated, 'node'));
    writeStub(isolated, 'uname', '#!/bin/sh\necho Linux\n');
    for (const name of commands) {
      const binary = ['/usr/bin', '/bin'].map(dir => join(dir, name)).find(existsSync);
      symlinkSync(binary, join(isolated, name));
    }
    const endpoint = ['--endpoint', 'example.invalid', '6543', 'example', 'example_db'];
    const invoke = args => spawnSync('/bin/bash', [join(root, 'scripts', 'db.sh'), ...args], {
      encoding: 'utf8', env: { PATH: isolated, STUB_LOG: stubLog, PGPASSWORD: 'test-only' },
    });
    expect(invoke(['export', ...endpoint, 'missing']).status).not.toBe(0);
    const dump = join(root, 'example.sql');
    writeFileSync(dump, FULL_DUMP);
    expect(invoke(['import', ...endpoint, dump]).status).not.toBe(0);
    expect(readFileSync(stubLog, 'utf8')).toBe('');
    expect(dumps()).toEqual([]);
  });

  it('imports legacy extension metadata through a private copy without changing stored data', async () => {
    const { databaseImportFixture } = await import('../server/test/fixtures/databaseImportDump.js');
    const { original, replay } = databaseImportFixture();
    const file = join(root, 'legacy.sql');
    writeFileSync(file, original);
    const result = run(['import', '--endpoint', 'example.invalid', '6543', 'example', 'example_test', file], 'ok');
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(importLog)).toEqual(replay);
    expect(readFileSync(file)).toEqual(original);
    // A changed original identity must fail before the target sees any bytes.
    rmSync(importLog);
    const rejected = run(['import', '--endpoint', 'example.invalid', '6543', 'example', 'example_test', file], 'ok', {
      PORTOS_IMPORT_SHA256: '0'.repeat(64),
    });
    expect(rejected.status).not.toBe(0);
    expect(existsSync(importLog)).toBe(false);
  });

  it('forwards the complete staged replay through Docker when host psql is absent', () => {
    const isolated = join(root, 'docker-only-bin');
    mkdirSync(isolated);
    for (const name of ['bash', 'cat', 'dirname', 'mktemp', 'rm', 'grep', 'cut', 'tr']) {
      const binary = ['/usr/bin', '/bin'].map(dir => join(dir, name)).find(existsSync);
      symlinkSync(binary, join(isolated, name));
    }
    for (const name of ['node', 'docker', 'uname']) {
      symlinkSync(join(root, 'bin', name), join(isolated, name));
    }
    const dump = join(root, 'docker-import.sql');
    writeFileSync(dump, FULL_DUMP);
    const result = run(['import', dump], 'ok', { PATH: isolated });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(importLog), 'Docker must receive SQL on stdin').toBe(true);
    expect(readFileSync(importLog, 'utf8')).toBe(FULL_DUMP);
    expect(result.stdout).toContain('Import complete');
    expect(readFileSync(dump, 'utf8')).toBe(FULL_DUMP);
  });

  it('rejects incomplete endpoints and connection-string database overrides before any database command', () => {
    for (const args of [
      ['--endpoint', 'example.invalid', '6543'],
      ['--endpoint', 'example.invalid', '0', 'example', 'example_db'],
      ['--endpoint', 'example.invalid', '65536', 'example', 'example_db'],
      ['--endpoint', 'example.invalid', '6543', 'example', 'host=other.invalid'],
      ['--endpoint', 'example.invalid', '6543', 'example', 'postgresql://other.invalid/db'],
      ['--endpoint', 'first.invalid,second.invalid', '6543', 'example', 'example_db'],
    ]) {
      expect(run(['export', ...args], 'ok').status).not.toBe(0);
    }
    expect(readFileSync(stubLog, 'utf8')).toBe('');
    expect(existsSync(dumpDir)).toBe(false);
  });

  it.each(['docker', 'native'])('refuses all cutover commands in %s mode before any database command', (mode) => {
    writeFileSync(envFile, `PGMODE=${mode}\n`);
    for (let attempt = 0; attempt < 2; attempt++) {
      for (const command of ['migrate', 'use-native', 'use-docker']) {
        const result = run([command], 'ok');
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/migration and switching are temporarily unavailable/);
        expect(readFileSync(stubLog, 'utf8')).toBe('');
        expect(existsSync(importLog)).toBe(false);
        expect(existsSync(dumpDir)).toBe(false);
        expect(readFileSync(envFile, 'utf8')).toBe(`PGMODE=${mode}\n`);
      }
    }
  });

  it('provisions native PostgreSQL without selecting it or stopping Docker', () => {
    const result = run(['setup-native'], 'ok');
    expect(result.status).toBe(0);
    expect(readFileSync(envFile, 'utf8')).toBe('PGMODE=docker\n');
    const log = readFileSync(stubLog, 'utf8');
    expect(log).toContain('--single-transaction');
    expect(log).not.toMatch(/SOURCE_STOP|docker compose stop/);
    expect(result.stdout).toContain('selected mode is unchanged');
  });

  // #10757: every host libpq client the script starts — readiness, bootstrap
  // probes and writes, schema, ordinary and explicit transfers — must run with
  // the routing variables removed, while supported TLS settings survive for the
  // ordinary paths. Pairing each client line with an environment line proves no
  // call site was missed.
  describe('inherited libpq routing variables (#10757)', () => {
    const poisoned = { PGHOSTADDR: '192.0.2.10', PGSERVICE: 'other', PGSERVICEFILE: '/example/service.conf', PGOPTIONS: '-c search_path=other', PGSSLMODE: 'require' };
    const clientLines = (log) => log.split('\n').filter(line => /^(psql|pg_dump|pg_isready) /.test(line));
    const envLines = (log) => log.split('\n').filter(line => line.startsWith('endpoint-env '));

    const expectRoutingRemoved = (log, { tls }) => {
      expect(envLines(log).length).toBe(clientLines(log).length);
      expect(envLines(log).length).toBeGreaterThan(0);
      for (const line of envLines(log)) expect(line).toBe(`endpoint-env unset|unset|unset|unset|tls=${tls}`);
      expect(log).not.toContain('192.0.2.10');
    };

    it('removes them from native readiness, role provisioning, database creation and schema application', () => {
      const result = run(['setup-native'], 'ok', { ...poisoned, PGPORT: '5433', PGHOST: 'db.example.invalid', READY_PORTS: '5433' });
      expect(result.status, result.stderr).toBe(0);
      const log = readFileSync(stubLog, 'utf8');
      expect(log).toContain('pg_isready');
      expect(psqlCalls().length).toBeGreaterThanOrEqual(6);
      expectRoutingRemoved(log, { tls: 'require' });
      expect(readFileSync(join(root, 'role.sql'), 'utf8')).toContain('CREATE ROLE :"role"');
      expect(log).not.toContain('test-only');
    });

    it.each(['docker', 'native'])('removes them from ordinary host export and import in saved %s mode', (mode) => {
      writeFileSync(envFile, `PGMODE=${mode}\nPGHOST=db.example.invalid\nPGPORT=6543\nPGPORT_DOCKER=6543\n`);
      const overrides = { ...poisoned, PGHOST: undefined };
      const exported = run(['export', 'ordinary'], 'ok', overrides);
      expect(exported.status, exported.stderr).toBe(0);
      const dump = join(dumpDir, 'portos-ordinary.sql');
      expect(run(['import', dump], 'ok', overrides).status).toBe(0);
      const log = readFileSync(stubLog, 'utf8');
      expect(log).toMatch(/pg_dump -h db\.example\.invalid -p 6543 /);
      expect(log).toMatch(/psql -h db\.example\.invalid -p 6543 .*--single-transaction/);
      expect(clientLines(log)).toHaveLength(2);
      expectRoutingRemoved(log, { tls: 'require' });
    });

    it('keeps explicit endpoint transfers on the stricter scrub that also drops TLS settings', () => {
      const endpoint = ['--endpoint', 'example.invalid', '6543', 'example', 'example_db'];
      expect(run(['export', ...endpoint, 'strict'], 'ok', poisoned).status).toBe(0);
      expectRoutingRemoved(readFileSync(stubLog, 'utf8'), { tls: 'unset' });
    });
  });

  const psqlCalls = () => readFileSync(stubLog, 'utf8').split('\n').filter(line => line.startsWith('psql '));

  it('provisions only the selected non-default endpoint while another cluster listens on the default port', () => {
    const result = run(['setup-native'], 'ok', { PGPORT: '5433', PGHOST: 'db.example.invalid', READY_PORTS: '5432 5433' });
    expect(result.status).toBe(0);
    const calls = psqlCalls();
    // role lookup, role alter, db list, two extensions, schema apply
    expect(calls.length).toBeGreaterThanOrEqual(6);
    for (const call of calls) expect(call).toContain('-h db.example.invalid -p 5433 ');
    expect(calls.some(call => call.includes('--single-transaction'))).toBe(true);
    expect(readFileSync(stubLog, 'utf8')).not.toMatch(/-p 5432\b/);
  });

  it('initializes a running non-default endpoint without any server on the default port', () => {
    const result = run(['setup-native'], 'ok', { PGPORT: '5433', READY_PORTS: '5433' });
    expect(result.status).toBe(0);
    expect(psqlCalls().length).toBeGreaterThanOrEqual(6);
    expect(psqlCalls().every(call => call.includes('-p 5433 '))).toBe(true);
    expect(readFileSync(join(root, 'role.sql'), 'utf8')).toContain('CREATE ROLE :"role"');
  });

  it('fails without issuing SQL to another cluster when the selected endpoint is down', () => {
    const result = run(['setup-native'], 'ok', { PGPORT: '5433', READY_PORTS: '5432' });
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toContain('127.0.0.1:5433');
    expect(psqlCalls()).toEqual([]);
    expect(readFileSync(envFile, 'utf8')).toBe('PGMODE=docker\n');
  });

  it('keeps a host-only selection on the default port instead of discovering another cluster', () => {
    const result = run(['setup-native'], 'ok', { PGHOST: 'db.example.invalid', READY_PORTS: '5432' });
    expect(result.status).toBe(0);
    expect(psqlCalls().every(call => call.includes('-h db.example.invalid -p 5432 '))).toBe(true);
    const down = run(['setup-native'], 'ok', { PGHOST: 'db.example.invalid', READY_PORTS: '5433' });
    expect(down.status).not.toBe(0);
    expect(psqlCalls().every(call => !call.includes('-p 5433 '))).toBe(true);
  });

  // #10484: a custom password must reach the target process through its
  // environment or stdin only, never as an argument a process list can show.
  describe('credential handling', () => {
    const SECRET = "p'a\"ss w;rd $(touch pwned) & \\back`tick`";

    const PROVISION_PSQL_STUB = `#!/bin/sh
echo "psql $*" >> "$STUB_LOG"
case "$*" in
  *pg_roles*) [ -n "$ROLE_EXISTS" ] && echo 1; exit 0 ;;
  *-lqt*) echo " $PGDATABASE |"; exit 0 ;;
  *--single-transaction*) cat >> "$IMPORT_LOG"; exit 0 ;;
  *-c*|*-f*) exit 0 ;;
esac
cat >> "$STUB_LOG_DIR/psql.stdin"
printf '%s|%s' "$PORTOS_BOOTSTRAP_ROLE" "$PORTOS_BOOTSTRAP_PASSWORD" >> "$STUB_LOG_DIR/psql.env"
exit "\${PROVISION_EXIT:-0}"
`;

    const DOCKER_ENV_STUB = DOCKER_STUB.replace('\n', '\nprintf "%s" "$PGPASSWORD" >> "$STUB_LOG_DIR/docker.env"\n');

    it.each([
      ['create', {}, 'CREATE ROLE :"role"'],
      ['alter', { ROLE_EXISTS: '1' }, 'ALTER USER :"role"'],
    ])('setup-native %s keeps the password out of argv and quotes it inside psql', (_name, extra, sql) => {
      writeStub(join(root, 'bin'), 'psql', PROVISION_PSQL_STUB);
      const result = run(['setup-native'], 'ok', { PGPASSWORD: SECRET, PGUSER: 'role"x', STUB_LOG_DIR: root, PGDATABASE: 'example_db', ...extra });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(stubLog, 'utf8')).not.toContain('p\'a');
      expect(result.stdout + result.stderr).not.toContain('w;rd');
      expect(existsSync(join(root, 'pwned'))).toBe(false);
      const stdin = readFileSync(join(root, 'psql.stdin'), 'utf8');
      expect(stdin).toContain(sql);
      expect(stdin).toContain("PASSWORD :'pw'");
      expect(stdin).not.toContain('w;rd');
      expect(readFileSync(join(root, 'psql.env'), 'utf8')).toBe('role"x|' + SECRET);
    });

    it('forwards the resolved settings to Compose so its own .env grammar cannot change them', () => {
      const composeLog = join(root, 'compose-env.log');
      writeFileSync(envFile, [
        'PGMODE=docker',
        'PGUSER=example-user',
        'PGDATABASE=example_db',
        'PGPASSWORD=example-pass # local note',
        'PGPORT_DOCKER=5599',
        '',
      ].join('\n'));
      const result = run(['stop'], 'ok', { PGPASSWORD: '', COMPOSE_ENV_LOG: composeLog });
      expect(result.status, result.stderr).toBe(0);
      const forwarded = () => new Set(readFileSync(composeLog, 'utf8').trim().split('\n'));
      expect(forwarded()).toEqual(new Set(['example-user|example_db|example-pass # local note|5599']));
      expect(readFileSync(stubLog, 'utf8')).not.toContain('example-pass');
      expect(result.stdout + result.stderr).not.toContain('example-pass');

      // A literal dollar expression is forwarded verbatim, not expanded.
      writeFileSync(envFile, 'PGMODE=docker\nPGPASSWORD="example-$PORTOS_PROBE_SUFFIX"\n');
      writeFileSync(composeLog, '');
      const dollar = run(['stop'], 'ok', { PGPASSWORD: '', COMPOSE_ENV_LOG: composeLog });
      expect(dollar.status, dollar.stderr).toBe(0);
      expect(forwarded()).toEqual(new Set(['portos|portos|example-$PORTOS_PROBE_SUFFIX|5561']));
    });

    it('setup-native fails when role provisioning fails', () => {
      writeStub(join(root, 'bin'), 'psql', PROVISION_PSQL_STUB);
      const result = run(['setup-native'], 'ok', { PGPASSWORD: SECRET, STUB_LOG_DIR: root, PROVISION_EXIT: '3' });
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain('Native PostgreSQL is ready');
      expect(result.stdout + result.stderr).not.toContain('w;rd');
    });

    it('docker export and import pass the password via the docker client environment only', () => {
      writeStub(join(root, 'bin'), 'docker', DOCKER_ENV_STUB);
      // Isolate PATH so a host psql/pg_dump (present on CI runners) cannot be reached.
      const isolated = join(root, 'docker-only-bin');
      mkdirSync(isolated);
      for (const name of ['bash', 'cat', 'dirname', 'mkdir', 'mktemp', 'rm', 'grep', 'cut', 'tr', 'sed', 'date', 'mv', 'chmod']) {
        const binary = ['/usr/bin', '/bin'].map(dir => join(dir, name)).find(existsSync);
        if (binary) symlinkSync(binary, join(isolated, name));
      }
      for (const name of ['node', 'docker', 'uname']) {
        symlinkSync(join(root, 'bin', name), join(isolated, name));
      }
      const exported = run(['export', 'secret'], 'ok', { PATH: isolated, PGPASSWORD: SECRET, STUB_LOG_DIR: root });
      expect(exported.status, exported.stderr).toBe(0);
      const dump = join(dumpDir, 'portos-secret.sql');
      const imported = run(['import', dump], 'ok', { PATH: isolated, PGPASSWORD: SECRET, STUB_LOG_DIR: root });
      expect(imported.status, imported.stderr).toBe(0);
      expect(readFileSync(stubLog, 'utf8')).toMatch(/docker exec .*-e PGPASSWORD portos-db pg_dump/);
      expect(readFileSync(stubLog, 'utf8')).toMatch(/docker exec -i .*-e PGPASSWORD portos-db psql/);
      expect(readFileSync(stubLog, 'utf8') + readFileSync(importLog, 'utf8')).not.toContain('w;rd');
      expect(readFileSync(join(root, 'docker.env'), 'utf8')).toContain(SECRET);
      expect(exported.stdout + exported.stderr + imported.stdout + imported.stderr).not.toContain('w;rd');
    });
  });
});
