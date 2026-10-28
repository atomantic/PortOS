// Exercise the real entry points with disposable configuration and fake commands.
// Injecting read errors is deterministic even when the runner can bypass chmod.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const password = 'example $literal # password';
const saved = `PGMODE = "native"\nPGPORT = '6543'\nPGUSER = "example user"\nPGDATABASE=example_db\nPGPASSWORD='${password}'\n`;

describe.skipIf(process.platform === 'win32')('saved environment read safety', () => {
  let root;
  let envPath;
  let logPath;
  let childEnv;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'env-read-safety-')));
    for (const relative of [
      'scripts/setup-db.js', 'scripts/db.sh', 'scripts/lib/envFile.js',
      'scripts/lib/envFile.cjs', 'scripts/lib/databaseSettings.cjs',
      'server/lib/bashResolver.js', 'server/lib/childProcess.js', 'ecosystem.config.cjs',
    ]) {
      const target = join(root, relative);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(repo, relative), target);
    }
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    envPath = join(root, '.env');
    logPath = join(root, 'commands.log');
    writeFileSync(envPath, saved);
    writeFileSync(logPath, '');
    writeFileSync(join(root, 'example.sql'), '-- synthetic dump\n');
    mkdirSync(join(root, 'bin'));
    symlinkSync(process.execPath, join(root, 'bin', 'node'));
    for (const command of ['docker', 'psql', 'pg_dump', 'pg_restore', 'pg_isready', 'brew']) {
      const target = join(root, 'bin', command);
      writeFileSync(target, `#!/bin/sh\nprintf '%s\\n' '${command}' >> "$STUB_LOG"\n${command === 'psql' ? 'echo 1' : 'exit 91'}\n`);
      chmodSync(target, 0o755);
    }
    const preload = join(root, 'read-error.cjs');
    writeFileSync(preload, `
const fs = require('node:fs');
const read = fs.readFileSync;
fs.readFileSync = function (path, ...args) {
  if (String(path) === process.env.STUB_ENV_PATH && process.env.STUB_READ_ERROR) {
    throw Object.assign(new Error('Synthetic environment read failure'), { code: process.env.STUB_READ_ERROR });
  }
  return read.call(this, path, ...args);
};
require('node:module').syncBuiltinESMExports();
`);
    // Deliberately do not inherit the install's database settings or NODE_OPTIONS.
    childEnv = {
      PATH: `${join(root, 'bin')}:/usr/bin:/bin`, HOME: root,
      NODE_OPTIONS: `--require=${preload}`, STUB_ENV_PATH: envPath, STUB_LOG: logPath,
    };
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function run(command, args, overrides = {}) {
    return spawnSync(command, args, {
      cwd: root, env: { ...childEnv, ...overrides }, encoding: 'utf8', timeout: 10000,
    });
  }

  const setup = () => join(root, 'scripts/setup-db.js');
  const cli = () => join(root, 'scripts/db.sh');
  const pm2Args = () => ['-e', `const { apps } = require('./ecosystem.config.cjs');
    console.log(JSON.stringify(apps.find(app => app.name === 'portos-server').env));`];
  const commands = () => readFileSync(logPath, 'utf8');

  it('retains the readable native backend and quoted settings in setup and PM2', () => {
    const result = run(process.execPath, [setup()]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('mode: native');
    expect(result.stdout).toContain('ready on port 6543');
    expect(commands()).toBe('psql\n');
    const config = run(process.execPath, pm2Args());
    expect(config.status, config.stderr).toBe(0);
    expect(JSON.parse(config.stdout)).toMatchObject({
      PGPORT: 6543, PGUSER: 'example user', PGDATABASE: 'example_db', PGPASSWORD: password,
    });
  });

  it.each(['EACCES', 'EIO'])('stops setup and PM2 before fallback on %s', (code) => {
    for (const args of [[setup()], pm2Args()]) {
      const result = run(process.execPath, args, { STUB_READ_ERROR: code });
      expect(result.status, result.stderr).not.toBe(0);
      expect(result.stderr).toContain(code);
      expect(result.stdout + result.stderr).not.toContain(password);
      expect(commands()).toBe('');
    }
  });

  it.each(['export', 'import', 'fix'])('refuses %s before any database command when configuration is unreadable', (action) => {
    const result = run('bash', [cli(), action, join(root, 'example.sql')], { STUB_READ_ERROR: 'EACCES' });
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain('Could not load database configuration; no database command was run');
    expect(result.stdout + result.stderr).not.toContain(password);
    expect(commands()).toBe('');
    expect(readFileSync(envPath, 'utf8')).toBe(saved);
    expect(readFileSync(join(root, 'example.sql'), 'utf8')).toBe('-- synthetic dump\n');
  });

  it('keeps missing-file defaults available to setup, PM2 and the CLI', () => {
    rmSync(envPath);
    const result = run(process.execPath, [setup()]);
    expect(result.stdout).toContain('mode: docker');
    expect(result.stderr).toContain('Docker not found');
    expect(commands()).toBe('docker\n');
    const config = run(process.execPath, pm2Args());
    expect(config.status, config.stderr).toBe(0);
    expect(JSON.parse(config.stdout)).toMatchObject({
      PGPORT: 5561, PGUSER: 'portos', PGDATABASE: 'portos', PGPASSWORD: 'portos',
    });
    const status = run('bash', [cli(), 'status']);
    expect(status.stdout + status.stderr).not.toContain('Could not load database configuration');
    expect(status.stdout).toContain('docker');
  });
});
