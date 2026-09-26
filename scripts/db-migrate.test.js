// Runs the real scripts/db.sh control flow against stubbed executables in a
// temporary root, so a failed pg_dump is proven to stop `migrate` before any
// import, mode change, or source shutdown (#8781). No real database is touched:
// every host command db.sh reaches (docker, psql, pg_dump, pg_isready, uname)
// is a stub placed ahead of the system directories on PATH.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
case "$*" in *count*) echo 3 ;; esac
exit 0
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
    writeStub(binDir, 'pg_isready', '#!/bin/sh\nexit 0\n');
    // Not Darwin, so db.sh skips prepending Homebrew's real Postgres to PATH.
    writeStub(binDir, 'uname', '#!/bin/sh\necho Linux\n');
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

  const run = (args, dumpMode) => spawnSync('bash', [join(root, 'scripts', 'db.sh'), ...args], {
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
      PGHOST: '127.0.0.1'
    }
  });

  const tempArtifacts = () => (existsSync(dumpDir) ? readdirSync(dumpDir).filter(f => f.startsWith('portos-export.')) : []);
  const dumps = () => (existsSync(dumpDir) ? readdirSync(dumpDir).filter(f => f.endsWith('.sql')) : []);

  it.each(['partial', 'empty'])('aborts migrate on a %s failed dump before import, mode change, or shutdown', (mode) => {
    const result = run(['migrate'], mode);

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

  it('imports the complete dump and switches mode once on success', () => {
    const result = run(['migrate'], 'ok');

    expect(result.status).toBe(0);
    expect(readFileSync(importLog, 'utf8')).toBe(FULL_DUMP);
    const log = readFileSync(stubLog, 'utf8');
    expect(log.match(/^IMPORT$/gm)).toHaveLength(1);
    expect(log.match(/^SOURCE_STOP$/gm)).toHaveLength(1);
    expect(readFileSync(envFile, 'utf8')).toBe('PGMODE=native\n');
    const [dump] = dumps();
    expect(readFileSync(join(dumpDir, dump), 'utf8')).toBe(FULL_DUMP);
    expect(tempArtifacts()).toEqual([]);
  });
});
