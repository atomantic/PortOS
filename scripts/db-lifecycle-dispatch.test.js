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
    copyFileSync(join(here, 'db.sh'), join(root, 'scripts', 'db.sh'));
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    const binDir = join(root, 'bin');
    mkdirSync(binDir);
    symlinkSync(process.execPath, join(binDir, 'node'));
    for (const name of ['docker', 'psql', 'pg_isready']) writeStub(binDir, name, LOGGING_STUB(name));
    // Not Darwin, so db.sh skips prepending a real Homebrew Postgres to PATH.
    writeStub(binDir, 'uname', '#!/bin/sh\necho Linux\n');
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
    const result = run('stop', NATIVE_CHILD);

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
});
