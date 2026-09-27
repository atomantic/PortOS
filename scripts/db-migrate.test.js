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
      *psql*) echo IMPORT >> "$STUB_LOG"; cat >> "$IMPORT_LOG"; exit 0 ;;
    esac ;;
esac
exit 0
`;

const PSQL_STUB = `#!/bin/sh
echo "psql $*" >> "$STUB_LOG"
echo "endpoint-env \${PGHOSTADDR-unset}|\${PGSERVICE-unset}|\${PGSERVICEFILE-unset}|\${PGOPTIONS-unset}" >> "$STUB_LOG"
case "$*" in *--single-transaction*) cat >> "$IMPORT_LOG"; exit "\${IMPORT_EXIT:-0}" ;; esac
case "$*" in *count*) echo 3 ;; esac
exit 0
`;

const PG_DUMP_STUB = `#!/bin/sh
echo "pg_dump $*" >> "$STUB_LOG"
echo "endpoint-env \${PGHOSTADDR-unset}|\${PGSERVICE-unset}|\${PGSERVICEFILE-unset}|\${PGOPTIONS-unset}" >> "$STUB_LOG"
case "$DUMP_MODE" in
  partial) printf 'DROP TABLE example_record;\\n'; exit 1 ;;
  empty) exit 1 ;;
  *) printf '%s' "$FULL_DUMP" ;;
esac
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
    mkdirSync(join(root, 'scripts'));
    copyFileSync(join(here, 'db.sh'), join(root, 'scripts', 'db.sh'));
    const binDir = join(root, 'bin');
    mkdirSync(binDir);
    writeStub(binDir, 'docker', DOCKER_STUB);
    writeStub(binDir, 'psql', PSQL_STUB);
    writeStub(binDir, 'pg_dump', PG_DUMP_STUB);
    writeStub(binDir, 'pg_isready', '#!/bin/sh\nexit 0\n');
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
});
