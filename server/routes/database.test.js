/**
 * Tests for POST /api/database/destroy (and the adjacent validation paths).
 *
 * Strategy: mock child_process.execFile — which is what runCmd() wraps — so
 * we can control every shell invocation without touching the real filesystem
 * or running actual Docker/psql commands.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';

// resolveBashBinary and the db.sh path are resolved at module load — mock
// the dependencies before the route is imported.
vi.mock('../lib/bashResolver.js', () => ({
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
  checkHealth: vi.fn(async () => ({ healthy: true })),
  query: vi.fn(async () => ({ rows: [] })),
}));

// Mock child_process.execFile + spawn at the module level.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    execFile: vi.fn(),
    spawn: vi.fn(),
  };
});

import { execFile, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join as pathJoin } from 'path';
import databaseRoutes, { isPg17OnlyDirective, importDumpFile } from './database.js';

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

  // Build a fake psql child process backed by real streams.
  function makeFakePsql() {
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
    child.kill = vi.fn();
    // Raw bytes piped to psql stdin, concatenated.
    child.__pipedBuffer = () => Buffer.concat(writes);
    child.__piped = (encoding = 'latin1') => Buffer.concat(writes).toString(encoding);
    return child;
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
});

describe('POST /api/database/destroy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    });
  });

  describe('native destroy path', () => {
    it('invokes psql DROP DATABASE when destroying the non-active native backend', async () => {
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
    });
  });
});
