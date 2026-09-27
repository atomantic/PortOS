/**
 * Tests for the database route boundary and destructive admin operations.
 *
 * Strategy: mock child_process.execFile — which is what runCmd() wraps — so
 * we can control every shell invocation without touching the real filesystem
 * or running actual Docker/psql commands.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';

vi.mock('../lib/paths.js', async (importOriginal) => {
  const { makePathsProxy, lazyTempDataRoot } = await import('../lib/mockPathsDataRoot.js');
  return makePathsProxy(await importOriginal(), {
    dataRoot: lazyTempDataRoot('portos-database-admin-'),
  });
});

// resolveBashBinary and the db.sh path are resolved at module load — mock
// the dependencies before the route is imported.
vi.mock('../lib/bashResolver.js', async (importOriginal) => ({
  ...(await importOriginal()),   // real toBashPath — only the binary needs pinning
  resolveBashBinary: vi.fn(() => 'bash'),
}));

vi.mock('../lib/pgTools.js', () => ({
  resolvePgDumpBinary: vi.fn(async () => ({ binary: 'pg_dump', satisfies: true })),
}));

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return {
    ...actual,
    PATHS: { ...actual.PATHS, root: '/fake/root' },
  };
});

vi.mock('../lib/db.js', () => ({
  POOL_CONFIG: { host: 'localhost', port: 5432, user: 'example_role', database: 'example_db', password: 'example_password' },
  checkHealth: vi.fn(async () => ({ healthy: true })),
  query: vi.fn(async () => ({ rows: [] })),
}));

// Wrap fs so a test can substitute a dump source that fails mid-stream — the
// mid-import read error the abort path exists for. Everything else delegates
// to the real module (the suite writes real temp dumps).
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createReadStream: vi.fn(actual.createReadStream),
  };
});

// Mock child_process.execFile + spawn at the module level.
vi.mock('../lib/childProcess.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    execFile: vi.fn(),
    spawn: vi.fn(),
  };
});

import { POOL_CONFIG, query, checkHealth } from '../lib/db.js';
import { execFile, spawn } from '../lib/childProcess.js';
import { EventEmitter } from 'events';
import { PassThrough, Readable } from 'stream';
import { writeFileSync, mkdtempSync, readFileSync, createReadStream, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join as pathJoin } from 'path';
import databaseRoutes from './database.js';
import { PATHS } from '../lib/paths.js';
import { createDatabaseMaintenanceJournal } from '../lib/databaseMaintenanceJournal.js';
import { cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';

afterAll(cleanupTempDataRoots);
import { isPg17OnlyDirective, importDumpFile } from '../services/dbAdmin.js';

// Helper: make execFile call the callback with controlled output
function mockExecFile(responses) {
  // responses: array of { exitCode, stdout, stderr } in call order.
  // Any call beyond the list resolves with exitCode=0.
  let callIndex = 0;
  execFile.mockImplementation((_cmd, _args, _opts, callback) => {
    const resp = responses[callIndex++] ?? { exitCode: 0, stdout: '', stderr: '' };
    if (resp.exitCode !== 0) {
      const err = Object.assign(new Error(resp.stderr || 'error'), { code: resp.exitCode });
      callback(err, resp.stdout || '', resp.stderr || '');
    } else {
      callback(null, resp.stdout || '', resp.stderr || '');
    }
    // Return a dummy handle (execFile should return a ChildProcess)
    return { pid: 0 };
  });
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/database', databaseRoutes);
  app.use((err, _req, res, _next) => {
    res.status(err.status ?? 500).json({ error: err.message, code: err.code });
  });
  return app;
}

describe('database route boundary', () => {
  it('delegates subprocess, filesystem, and database work to dbAdmin', () => {
    const source = readFileSync(new URL('./database.js', import.meta.url), 'utf8');

    expect(source).toContain("from '../services/dbAdmin.js'");
    expect(source).not.toMatch(/childProcess|from 'fs'|from 'fs\/promises'|from '\.\.\/lib\/db\.js'/);
    expect(source).not.toMatch(/\b(?:execFile|spawn|query|mkdirSync|createReadStream)\s*\(/);
  });
});

// Regression: an API migration must not start the unfenced snapshot/cutover,
// even for an older client that still exposes the migration button.
describe('database migration admission', () => {
  it.each([['docker', true], ['native', true], ['docker', false], ['native', false]])('refuses repeated cutovers to %s (migrate=%s) without side effects', async (target, migrate) => {
    vi.clearAllMocks();
    const app = makeApp();
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await request(app).post('/api/database/switch').send({ target, migrate });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('DATABASE_CUTOVER_UNAVAILABLE');
      expect(res.body.error).toMatch(/coordinated shutdown and restart/);
    }
    expect(execFile).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(checkHealth).not.toHaveBeenCalled();
  });
});

// Regression: raw shell admin operations bypass the pooled DB write fence.
// Exercise the real durable journal through HTTP, without a live database.
describe('database admin maintenance admission', () => {
  it('refuses every admin operation while fenced and resumes after source-only cancellation', async () => {
    vi.clearAllMocks();
    const journal = createDatabaseMaintenanceJournal(PATHS.data);
    const source = { mode: 'native', host: 'localhost', port: 5432, database: 'example_test', user: 'example_role' };
    const operation = journal.begin({ source, target: { ...source, mode: 'docker', port: 5561 } });
    try {
      for (const [route, body] of [
        ['switch', { target: 'docker', migrate: true }],
        ['sync', {}], ['start', { backend: 'docker' }],
        ['stop', { backend: 'native' }], ['destroy', { backend: 'docker' }],
        ['setup-native', {}], ['fix', {}],
        ['export', {}], ['export', { backend: 'docker' }],
      ]) {
        const res = await request(makeApp()).post(`/api/database/${route}`).send(body);
        expect(res.status, route).toBe(503);
        expect(res.body.code, route).toBe('DATABASE_MAINTENANCE');
      }
      expect(execFile).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
      expect(checkHealth).not.toHaveBeenCalled();
    } finally {
      journal.cancel(operation.id, source);
    }
    mockExecFile([{ exitCode: 0, stdout: 'started' }]);
    expect((await request(makeApp()).post('/api/database/start').send({ backend: 'docker' })).status).toBe(200);
    expect(execFile).toHaveBeenCalledTimes(1);
  });
});

// A fenced operation must remain inspectable without pool/shell admission,
// while endpoint identities and damaged on-disk bytes never reach the API.
describe('database maintenance status', () => {
  afterEach(() => {
    rmSync(pathJoin(PATHS.data, 'database-maintenance'), { recursive: true, force: true });
  });

  it('reports idle and current durable progress without exposing endpoints or reopening admission', async () => {
    vi.clearAllMocks();
    const app = makeApp();
    const idle = await request(app).get('/api/database/maintenance/status');
    expect(idle.status).toBe(200);
    expect(idle.body).toEqual({ stage: 'idle', fenced: false });
    expect(idle.headers['cache-control']).toBe('no-store');

    const journal = createDatabaseMaintenanceJournal(PATHS.data);
    const source = { mode: 'native', host: 'localhost', port: 5432, database: 'example_test', user: 'example_role' };
    const operation = journal.begin({ source, target: { ...source, mode: 'docker', port: 5561 } });
    const accepted = await request(app).get('/api/database/maintenance/status');
    expect(accepted.body).toEqual({
      id: operation.id, stage: 'accepted', coordinator: 'unclaimed', source: 'native', target: 'docker', fenced: true,
    });
    const owner = journal.acquireCoordinator(operation.id);
    const stages = ['accepted', 'quiescing', 'exporting', 'importing'];
    for (let i = 1; i < stages.length; i++) {
      journal.transition(operation.id, owner, stages[i - 1], stages[i]);
    }
    const importing = await request(app).get('/api/database/maintenance/status');
    expect(importing.status).toBe(200);
    expect(importing.body).toEqual({ ...accepted.body, stage: 'importing', coordinator: 'unregistered' });
    expect(() => journal.assertAdmission()).toThrow();
    expect(execFile).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(checkHealth).not.toHaveBeenCalled();
  });

  it('returns a non-cacheable maintenance error for damaged state instead of reporting idle', async () => {
    vi.clearAllMocks();
    const journal = createDatabaseMaintenanceJournal(PATHS.data);
    const source = { mode: 'docker', host: 'localhost', port: 5561, database: 'example_test', user: 'example_role' };
    journal.begin({ source, target: { ...source, mode: 'native', port: 5432 } });
    writeFileSync(pathJoin(PATHS.data, 'database-maintenance', 'operation.json'), 'example damaged private bytes');
    const response = await request(makeApp()).get('/api/database/maintenance/status');
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('DATABASE_MAINTENANCE');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.text).not.toContain('example damaged private bytes');
    expect(() => journal.assertAdmission()).toThrow();
    expect(execFile).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(checkHealth).not.toHaveBeenCalled();
  });
});

describe('isPg17OnlyDirective (sed-replacement line filter)', () => {
  it('matches the pg17-only directives the legacy sed stripped', () => {
    expect(isPg17OnlyDirective('\\restrict abc123')).toBe(true);
    expect(isPg17OnlyDirective('\\unrestrict abc123')).toBe(true);
    expect(isPg17OnlyDirective('SET transaction_timeout = 0;')).toBe(true);
  });

  it('leaves ordinary dump lines untouched', () => {
    expect(isPg17OnlyDirective('CREATE TABLE foo (id int);')).toBe(false);
    expect(isPg17OnlyDirective('SET statement_timeout = 0;')).toBe(false);
    expect(isPg17OnlyDirective("INSERT INTO t VALUES ('\\restrict not-a-directive');")).toBe(false);
    expect(isPg17OnlyDirective('  \\restrict indented')).toBe(false); // anchored at start, like sed /^…/
    expect(isPg17OnlyDirective('')).toBe(false);
  });
});

describe('importDumpFile (no-shell streaming import)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Build a fake psql child process backed by real streams. `closeOnKill`
  // models a terminated psql emitting 'close' asynchronously; tests that must
  // control exactly when the close lands pass false and emit it themselves.
  function makeFakePsql({ closeOnKill = true } = {}) {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const writes = [];
    child.stdin = new PassThrough();
    child.stdin.on('data', (chunk) => writes.push(Buffer.from(chunk)));
    child.stdin.on('finish', () => {
      // Emulate psql exiting cleanly once stdin closes.
      child.emit('close', 0);
    });
    child.kill = vi.fn((signal) => {
      if (closeOnKill) process.nextTick(() => child.emit('close', null, signal));
      return true;
    });
    // Raw bytes piped to psql stdin, concatenated.
    child.__pipedBuffer = () => Buffer.concat(writes);
    child.__piped = (encoding = 'latin1') => Buffer.concat(writes).toString(encoding);
    return child;
  }

  // A dump source that delivers `prefix` (complete SQL statements), then fails
  // the read — the mid-import error that must abort the child, not EOF it.
  function makeFailingSource(prefix, message = 'dump read failed mid-stream') {
    return Readable.from((async function* () {
      yield prefix;
      throw new Error(message);
    })(), { encoding: 'latin1' });
  }

  it('spawns psql via argv without a shell and pipes filtered dump to stdin', async () => {
    const child = makeFakePsql();
    spawn.mockReturnValue(child);

    const dir = mkdtempSync(pathJoin(tmpdir(), 'portos-dump-'));
    const dumpPath = pathJoin(dir, 'dump.sql');
    writeFileSync(dumpPath,
      '\\restrict token\n' +
      'SET transaction_timeout = 0;\n' +
      'CREATE TABLE foo (id int);\n' +
      '\\unrestrict token\n' +
      "INSERT INTO foo VALUES (1);\n"
    );

    const result = await importDumpFile(dumpPath, '5561', { PGPASSWORD: 'x' });

    expect(result.exitCode).toBe(0);
    // spawn called with the psql binary and an argv array (no shell / no bash -c).
    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawn.mock.calls[0];
    expect(cmd).toBe('psql');
    expect(Array.isArray(args)).toBe(true);
    expect(args).toContain('--single-transaction');
    expect(args).toContain('ON_ERROR_STOP=1');
    // No shell option and no interpolated command string.
    expect(opts.shell).toBeFalsy();
    expect(args.join(' ')).not.toMatch(/sed|\|/);

    // The pg17-only directives were stripped; real SQL survived.
    const piped = child.__piped();
    expect(piped).not.toMatch(/\\restrict/);
    expect(piped).not.toMatch(/\\unrestrict/);
    expect(piped).not.toMatch(/SET transaction_timeout/);
    expect(piped).toMatch(/CREATE TABLE foo/);
    expect(piped).toMatch(/INSERT INTO foo VALUES \(1\);/);
  });

  it('preserves raw bytes (non-utf8-safe) instead of round-tripping through utf8', async () => {
    const child = makeFakePsql();
    spawn.mockReturnValue(child);

    const dir = mkdtempSync(pathJoin(tmpdir(), 'portos-dump-'));
    const dumpPath = pathJoin(dir, 'dump.sql');
    // A lone 0xE9 byte (LATIN1 'é') is NOT valid standalone UTF-8; a utf8
    // decode→re-encode would replace it with 0xEFBFBD. Plus a valid multibyte
    // UTF-8 sequence (emoji) that must also survive unchanged.
    const body = Buffer.concat([
      Buffer.from('INSERT INTO t VALUES (', 'utf8'),
      Buffer.from([0xe9]),               // raw LATIN1 byte
      Buffer.from(' -- 😀\n', 'utf8'),   // valid UTF-8 multibyte
    ]);
    writeFileSync(dumpPath, body);

    const result = await importDumpFile(dumpPath, '5561', {});
    expect(result.exitCode).toBe(0);

    // Bytes piped to psql must equal the input bytes exactly (line kept; the
    // '\n' terminator is re-emitted by the line filter).
    expect(child.__pipedBuffer().equals(body)).toBe(true);
  });

  it('preserves CR bytes in CRLF-terminated dumps (does not normalize to LF)', async () => {
    const child = makeFakePsql();
    spawn.mockReturnValue(child);

    const dir = mkdtempSync(pathJoin(tmpdir(), 'portos-dump-'));
    const dumpPath = pathJoin(dir, 'dump.sql');
    // A CRLF file with a stripped directive line and two data lines. The CR
    // bytes on the surviving lines must be preserved.
    const body = Buffer.from(
      '\\restrict tok\r\nCREATE TABLE t (id int);\r\nINSERT INTO t VALUES (1);\r\n',
      'latin1'
    );
    writeFileSync(dumpPath, body);

    const result = await importDumpFile(dumpPath, '5561', {});
    expect(result.exitCode).toBe(0);

    const expected = Buffer.from(
      'CREATE TABLE t (id int);\r\nINSERT INTO t VALUES (1);\r\n',
      'latin1'
    );
    expect(child.__pipedBuffer().equals(expected)).toBe(true);
  });

  it('resolves with a non-zero exitCode when the dump file cannot be read (no throw)', async () => {
    const child = makeFakePsql();
    spawn.mockReturnValue(child);

    const result = await importDumpFile('/nonexistent/dump.sql', '5432', {});
    expect(result.exitCode).not.toBe(0);
  });

  it('aborts psql without a normal EOF when the dump read fails after a complete SQL prefix', async () => {
    // closeOnKill: false — the test owns when the child's 'close' lands, so it
    // can prove the promise stays unsettled until then.
    const child = makeFakePsql({ closeOnKill: false });
    spawn.mockReturnValue(child);
    const stdinEnd = vi.spyOn(child.stdin, 'end');
    createReadStream.mockImplementationOnce(() => makeFailingSource(
      'DROP TABLE memories;\nINSERT INTO memories VALUES (1);\n'
    ));

    let settled = false;
    const promise = importDumpFile('/fake/dump.sql', '5561', {})
      .then((r) => { settled = true; return r; });

    // The destructive prefix reached psql's stdin, the read failed, and the
    // child was told to terminate — before the promise resolves.
    await vi.waitFor(() => {
      expect(child.__piped()).toContain('DROP TABLE memories;');
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    });

    // No end-of-script EOF: stdin.end() is what would let psql commit the
    // already-delivered statements under --single-transaction.
    expect(stdinEnd).not.toHaveBeenCalled();
    // The caller is NOT told the import finished while the child could still
    // be alive — settlement waits on the confirmed close.
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    child.emit('close', null, 'SIGTERM');
    const result = await promise;
    expect(result.exitCode).not.toBe(0);
    // The original read error is preserved in the returned diagnostic.
    expect(result.stderr).toContain('dump read failed mid-stream');
    expect(stdinEnd).not.toHaveBeenCalled();
  });

  it('escalates a stalled abort to SIGKILL and still resolves the failure bounded', async () => {
    vi.useFakeTimers();
    try {
      const child = makeFakePsql({ closeOnKill: false }); // wedged: never closes
      spawn.mockReturnValue(child);
      createReadStream.mockImplementationOnce(() => makeFailingSource(
        'DROP TABLE memories;\n'
      ));

      const promise = importDumpFile('/fake/dump.sql', '5561', {});
      // Under fake timers the stream's internal setImmediate is faked too;
      // advancing the clock by 0 pumps it plus the generator microtasks, so
      // the yield→data→throw→error chain runs and abort() fires SIGTERM.
      await vi.advanceTimersByTimeAsync(0);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');

      // SIGTERM grace, then SIGKILL grace — both bounds elapse with no close,
      // so the import reports failure rather than hanging the sync request.
      const result = await Promise.race([
        promise,
        vi.advanceTimersByTimeAsync(10_000).then(() => 'still pending'),
      ]);
      const signals = child.kill.mock.calls.map((c) => c[0]);
      expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
      expect(result).not.toBe('still pending');
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('dump read failed mid-stream');
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds escalation when both termination signals synchronously emit errors', async () => {
    vi.useFakeTimers();
    try {
      const child = makeFakePsql({ closeOnKill: false });
      const failKill = () => {
        child.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM' }));
        return false;
      };
      // Two consecutive failures reproduce Node's synchronous error delivery;
      // the fallback prevents a regressed implementation overflowing the test runner.
      child.kill.mockImplementation(() => false)
        .mockImplementationOnce(failKill).mockImplementationOnce(failKill);
      spawn.mockReturnValue(child);
      const stdinEnd = vi.spyOn(child.stdin, 'end');
      createReadStream.mockImplementationOnce(() => makeFailingSource('SELECT 1;\n'));

      const promise = importDumpFile('/fake/dump.sql', '5561', {});
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await promise;
      expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
      expect(stdinEnd).not.toHaveBeenCalled();
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('dump read failed mid-stream');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps waiting for close when the child errors mid-abort and settles once', async () => {
    const child = makeFakePsql({ closeOnKill: false });
    spawn.mockReturnValue(child);
    createReadStream.mockImplementationOnce(() => makeFailingSource(
      'DROP TABLE memories;\n'
    ));

    const promise = importDumpFile('/fake/dump.sql', '5561', {});
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith('SIGTERM'));

    // A failed termination surfaces as 'error' — the child may still be
    // running, so the abort escalates instead of resolving early.
    child.emit('error', new Error('kill failed'));
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');

    // The confirmed close settles the promise; a duplicate lifecycle event is
    // a no-op.
    child.emit('close', null, 'SIGKILL');
    child.emit('close', null, 'SIGKILL');
    const result = await promise;
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('dump read failed mid-stream');
  });
});

describe('POST /api/database/destroy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('input validation', () => {
    it('returns 400 when backend is missing', async () => {
      const app = makeApp();
      const res = await request(app).post('/api/database/destroy').send({});
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.context.details.some((d) => d.path === 'backend')).toBe(true);
    });

    it('returns 400 when backend is an unknown value', async () => {
      const app = makeApp();
      const res = await request(app)
        .post('/api/database/destroy')
        .send({ backend: 'mysql' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.context.details.some((d) => d.path === 'backend')).toBe(true);
    });

    it('returns 400 when backend is null', async () => {
      const app = makeApp();
      const res = await request(app)
        .post('/api/database/destroy')
        .send({ backend: null });
      expect(res.status).toBe(400);
    });
  });

  describe('active-backend safety guard', () => {
    it('returns 400 when the requested backend matches the active backend (docker)', async () => {
      // First execFile call is runDbScript(['status']) → returns "Current mode: docker"
      mockExecFile([
        { exitCode: 0, stdout: 'Current mode: docker\nSome other output', stderr: '' },
      ]);

      const app = makeApp();
      const res = await request(app)
        .post('/api/database/destroy')
        .send({ backend: 'docker' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/active/i);
    });

    it('returns 400 when the requested backend matches the active backend (native)', async () => {
      mockExecFile([
        { exitCode: 0, stdout: 'Current mode: native', stderr: '' },
      ]);

      const app = makeApp();
      const res = await request(app)
        .post('/api/database/destroy')
        .send({ backend: 'native' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/active/i);
    });
  });

  describe('docker destroy path', () => {
    it('invokes docker stop, rm, and volume rm commands when destroying non-active docker backend', async () => {
      vi.stubEnv('PGHOST', 'localhost');
      vi.stubEnv('PGPORT', '5432');
      // Call order:
      // 0: runDbScript(['status'])  → mode is "native" (so docker is the non-active backend)
      // 1: docker compose stop db
      // 2: docker compose rm -f db
      // 3: docker volume rm -f portos_portos-pgdata  (first volume attempt)
      // 4: docker volume rm -f portos-pgdata          (alternate volume attempt)
      mockExecFile([
        { exitCode: 0, stdout: 'Current mode: native', stderr: '' },
        { exitCode: 0, stdout: '', stderr: '' }, // compose stop
        { exitCode: 0, stdout: '', stderr: '' }, // compose rm
        { exitCode: 0, stdout: '', stderr: '' }, // volume rm primary
        { exitCode: 0, stdout: '', stderr: '' }, // volume rm alternate
      ]);

      const app = makeApp();
      const res = await request(app)
        .post('/api/database/destroy')
        .send({ backend: 'docker' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify the first call was the status probe
      const statusCall = execFile.mock.calls[0];
      expect(statusCall[1]).toContain('status'); // db.sh status arg

      // Verify one of the calls used 'docker' as the command with compose/volume args
      const dockerCalls = execFile.mock.calls.filter(c => c[0] === 'docker');
      expect(dockerCalls.length).toBeGreaterThanOrEqual(3);

      const volumeRmCall = dockerCalls.find(
        c => c[1].includes('volume') && c[1].includes('rm')
      );
      expect(volumeRmCall).toBeDefined();
      expect(execFile.mock.calls.some(c => c[0] === 'psql')).toBe(false);
    });
  });

  describe('native destroy path', () => {
    it('targets the canonical native endpoint instead of the active Docker port', async () => {
      vi.stubEnv('PGHOST', 'localhost');
      vi.stubEnv('PGPORT', '5561');
      // Call order:
      // 0: runDbScript(['status']) → mode is "docker" (so native is non-active)
      // 1: psql DROP DATABASE …
      mockExecFile([
        { exitCode: 0, stdout: 'Current mode: docker', stderr: '' },
        { exitCode: 0, stdout: 'DROP DATABASE', stderr: '' },
      ]);

      const app = makeApp();
      const res = await request(app)
        .post('/api/database/destroy')
        .send({ backend: 'native' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify a psql call was made
      const psqlCall = execFile.mock.calls.find(c => c[0] === 'psql');
      expect(psqlCall).toBeDefined();
      // The args should contain a DROP DATABASE statement
      expect(psqlCall[1].join(' ')).toMatch(/DROP DATABASE/i);
      expect(psqlCall[1][psqlCall[1].indexOf('-p') + 1]).toBe('5432');
      expect(psqlCall[1]).not.toContain('5561');
    });
  });

  describe('endpoint identity safety', () => {
    it.each([
      ['native', 'docker', '5432', '127.0.0.1'],
      ['docker', 'native', '5561', '::1'],
    ])('refuses %s when its target aliases the active %s endpoint', async (backend, mode, port, host) => {
      vi.stubEnv('PGHOST', host);
      vi.stubEnv('PGPORT', port);
      mockExecFile([
        { exitCode: 0, stdout: `Current mode: ${mode}`, stderr: '' },
      ]);

      const app = makeApp();
      const res = await request(app)
        .post('/api/database/destroy')
        .send({ backend });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/active backend/i);
      expect(execFile).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['failed', { exitCode: 1, stdout: '', stderr: 'status failed' }],
      ['unparseable', { exitCode: 0, stdout: 'Database status unavailable', stderr: '' }],
    ])('fails closed on a %s status probe', async (_case, statusResponse) => {
      vi.stubEnv('PGHOST', 'localhost');
      vi.stubEnv('PGPORT', '5561');
      mockExecFile([statusResponse]);

      const app = makeApp();
      const res = await request(app)
        .post('/api/database/destroy')
        .send({ backend: 'native' });

      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/cannot verify/i);
      expect(execFile).toHaveBeenCalledTimes(1);
    });
  });
});


describe('POST /api/database/sync endpoint safety', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    POOL_CONFIG.host = 'localhost';
    POOL_CONFIG.port = 5432;
  });

  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ['docker', 5432, '127.0.0.1'],
    ['native', 5561, '::1'],
    ['native', 5432, 'db.example.com'],
  ])('refuses saved %s with a mismatched running endpoint', async (mode, port, host) => {
    Object.assign(POOL_CONFIG, { port, host });
    // Environment drift must not override the pool captured at startup.
    vi.stubEnv('PGPORT', mode === 'docker' ? '5561' : '5432');
    mockExecFile([{ exitCode: 0, stdout: `Current mode: ${mode}` }]);
    const res = await request(makeApp()).post('/api/database/sync').send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/restart before syncing/);
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    { exitCode: 1, stdout: 'Current mode: native', stderr: 'failed' },
    { exitCode: 0, stdout: 'Current mode: unknown' },
    { exitCode: 0, stdout: '' },
  ])('refuses an unsuccessful or unknown status probe: %j', async (response) => {
    mockExecFile([response]);
    const res = await request(makeApp()).post('/api/database/sync').send({});
    expect(res.status).toBe(409);
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([['native', 5432, '5561'], ['docker', 5561, '5432']])(
    'pins %s export and import to distinct endpoints with configured credentials',
    async (mode, port, targetPort) => {
      POOL_CONFIG.port = port;
      const mkdir = vi.spyOn(await import('fs'), 'mkdirSync').mockImplementation(() => undefined);
      createReadStream.mockImplementationOnce(() => Readable.from(['SELECT 1;\n']));
      execFile.mockImplementation((_cmd, args, _opts, callback) => {
        callback(null, args.includes('status') ? `Current mode: ${mode}` : '1', '');
      });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.stdin.resume();
      child.stdin.on('finish', () => child.emit('close', 0));
      spawn.mockReturnValue(child);
      try {
        const res = await request(makeApp()).post('/api/database/sync').send({});
        expect(res.status).toBe(200);
        const dump = execFile.mock.calls.find(([cmd]) => cmd === 'pg_dump');
        expect(dump[1]).toEqual(expect.arrayContaining(['-h', 'localhost', '-p', String(port), '-U', 'example_role', '-d', 'example_db']));
        expect(dump[2].env).toMatchObject({ PGPORT: String(port), PGPASSWORD: 'example_password' });
        expect(spawn.mock.calls[0][1]).toEqual(expect.arrayContaining(['-p', targetPort, '-U', 'example_role', '-d', 'example_db']));
        expect(spawn.mock.calls[0][2].env).toMatchObject({ PGPORT: targetPort, PGPASSWORD: 'example_password' });
        expect(execFile.mock.calls.filter(([, args]) => args.includes('export'))).toHaveLength(0);
      } finally {
        mkdir.mockRestore();
      }
    }
  );

  it('rejects competing mutations while sync is pending and releases after failure', async () => {
    let finishProbe;
    execFile.mockImplementation((_cmd, _args, _opts, callback) => { finishProbe = callback; });
    const app = makeApp();
    const pending = request(app).post('/api/database/sync').send({}).then(res => res);
    await vi.waitFor(() => expect(finishProbe).toBeTypeOf('function'));
    for (const [route, body] of [
      ['switch', { target: 'docker', migrate: false }],
      ['destroy', { backend: 'docker' }],
      ['sync', {}],
      ['export', {}],
    ]) {
      const res = await request(app).post(`/api/database/${route}`).send(body);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/in progress/);
    }
    expect(execFile).toHaveBeenCalledTimes(1);
    finishProbe(new Error('probe failed'), '', 'probe failed');
    expect((await pending).status).toBe(409);
    mockExecFile([{ exitCode: 0, stdout: 'Current mode: native' }]);
    const res = await request(app).post('/api/database/destroy').send({ backend: 'docker' });
    expect(res.status).toBe(200);
  });
});

// Host-control gating (#8897): database admin routes require operator authority.
describe('database admin routes host-control gating', () => {
  it.each([
    ['start', { backend: 'docker' }],
    ['stop', { backend: 'native' }],
    ['destroy', { backend: 'docker' }],
    ['setup-native', {}],
    ['export', {}],
    ['sync', {}],
    ['fix', {}],
    ['switch', { target: 'docker', migrate: false }],
  ])('requires host-control authority for POST /api/database/%s', async (route, body) => {
    const gated = express();
    gated.use((req, _res, next) => {
      req.portosAuthContext = { enabled: true, authenticated: false };
      next();
    });
    const { hostControlRouteGate } = await import('../services/authGate.js');
    gated.use(hostControlRouteGate);
    gated.use(express.json());
    gated.use('/api/database', databaseRoutes);
    const res = await request(gated).post(`/api/database/${route}`).send(body);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('HOST_CONTROL_FORBIDDEN');
    expect(execFile).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('allows preflight without host-control authority (advisory only)', async () => {
    const gated = express();
    gated.use((req, _res, next) => {
      req.portosAuthContext = { enabled: true, authenticated: false };
      next();
    });
    const { hostControlRouteGate } = await import('../services/authGate.js');
    gated.use(hostControlRouteGate);
    gated.use(express.json());
    gated.use('/api/database', databaseRoutes);
    const res = await request(gated).post('/api/database/maintenance/preflight').send({ source: 'native', target: 'docker' });
    // preflight is read-only advisory, but returns 400 for this test input
    // (no actual system idle) rather than 403.
    expect(res.status).not.toBe(403);
  });
});
