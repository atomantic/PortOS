import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { runInNewContext } from 'node:vm';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  parseDockerPort,
  parseNativePort,
} from './lib/setupDbChoice.js';

const here = dirname(fileURLToPath(import.meta.url));
const setupDbSrc = readFileSync(join(here, 'setup-db.js'), 'utf8');
const dockerComposeSrc = readFileSync(join(here, '..', 'docker-compose.yml'), 'utf8');
const dockerPortBindings = dockerComposeSrc.match(/^    ports:\r?\n((?:^      - .*(?:\r?\n|$))+)/m)?.[1]
  ?.trim()
  .split(/\r?\n/)
  .map((binding) => binding.trim());

describe('Docker PostgreSQL host binding', () => {
  it('publishes the configured host port on loopback only', () => {
    expect(dockerPortBindings).toEqual(['- "127.0.0.1:${PGPORT_DOCKER:-5561}:5432"']);
  });
});

describe('setup-db docker-port resolver (success log accuracy)', () => {
  it('defaults to 5561 when unset / non-numeric', () => {
    expect(parseDockerPort(undefined)).toBe(5561);
    expect(parseDockerPort('')).toBe(5561);
    expect(parseDockerPort('not-a-port')).toBe(5561);
  });

  it('honors a configured PGPORT_DOCKER, tolerating whitespace', () => {
    expect(parseDockerPort('5599')).toBe(5599);
    expect(parseDockerPort('  6000  ')).toBe(6000);
  });

  it('native port falls back to 5432 the same way', () => {
    expect(parseNativePort(undefined)).toBe(5432);
    expect(parseNativePort('  5433  ')).toBe(5433);
  });

  it('setup-db.js interpolates the resolved docker port, not a hardcoded 5561', () => {
    expect(setupDbSrc).toContain('PostgreSQL ready on port ${PG_PORT_DOCKER}');
    expect(setupDbSrc).not.toContain("'✅ PostgreSQL ready on port 5561'");
  });
});

describe('native setup inherited endpoint', () => {
  it('builds native subprocess settings from native identity, not the active Docker port', () => {
    // Execute the real setup configuration boundary without starting its menu,
    // probing PostgreSQL, or loading the install's .env.
    const start = setupDbSrc.indexOf('const envVar =');
    const end = setupDbSrc.indexOf('function getMode()');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const configure = (env) => runInNewContext(
      setupDbSrc.slice(start, end) + '\nPG_CHILD_ENV',
      { process: { env }, envFile: {}, parseNativePort, parseDockerPort },
    );
    expect(configure({ PGPORT: '5570', PORTOS_NATIVE_PGPORT: '5433' }).PGPORT).toBe('5433');
    expect(configure({ PGPORT: '5434' }).PGPORT).toBe('5434');
  });
});

// Run the actual CLI body with synthetic configuration and subprocesses. No
// imports execute, no install .env is read, and no database can be contacted.
async function runSetup({ mode = 'docker', unavailable, tty = false, nativeReady = true, running = true } = {}) {
  const savedEnv = { PGMODE: mode, EXAMPLE_SETTING: 'preserved' };
  const initialEnv = { ...savedEnv };
  const calls = [];
  const errors = [];
  const exitSignal = {};
  let exitCode = 0;
  let provisioned = false;
  const source = setupDbSrc.replace(/^#!.*\n/, '').replace(/^import .*;\n/gm, '')
    .replace('import.meta.url', 'scriptUrl');
  try {
    await runInNewContext(`(async () => {${source}\n})()`, {
      scriptUrl: 'file:///example/scripts/setup-db.js', dirname, join, fileURLToPath,
      parseNativePort, parseDockerPort,
      parseEnvFile: () => savedEnv,
      upsertEnvKey: (_path, key, value) => { savedEnv[key] = value; },
      createInterface: () => { throw new Error('Setup must not prompt to switch backends'); },
      resolveBashBinary: () => 'bash',
      process: {
        env: {}, platform: 'linux', stdin: { isTTY: tty }, stdout: { isTTY: tty },
        exit: (code) => { exitCode = code; throw exitSignal; }
      },
      console: { log: () => {}, error: (message) => errors.push(message) },
      execFileSync: (command, args) => {
        calls.push([command, ...args]);
        const invocation = [command, ...args].join(' ');
        if (invocation === unavailable) throw new Error('Synthetic unavailable dependency');
        if (command === 'psql') return nativeReady || provisioned ? '1\n' : '';
        if (command === 'bash' && args[1] === 'setup-native') {
          provisioned = true;
          return '';
        }
        if (invocation === 'docker compose ps --format json db') return running ? '{"State":"running"}' : '';
        if (invocation.startsWith('docker compose exec -T db psql')) return '1\n';
        if (['docker --version', 'docker info', 'docker compose version',
          'docker compose up -d db', 'docker compose exec -T db pg_isready -h 127.0.0.1 -U portos'].includes(invocation)) return '';
        throw new Error(`Unexpected synthetic subprocess: ${invocation}`);
      }
    });
  } catch (error) {
    if (error !== exitSignal) throw error;
  }
  expect(savedEnv).toEqual(initialEnv);
  return { exitCode, calls, errors };
}

describe('setup preserves the selected database', () => {
  it.each(['docker --version', 'docker info', 'docker compose version'])(
    'fails safely when %s is unavailable despite a healthy native database', async (unavailable) => {
      for (const tty of [false, true]) {
        const result = await runSetup({ unavailable, tty });
        expect(result.exitCode).toBe(1);
        expect(result.calls.every(([command]) => command === 'docker')).toBe(true);
        expect(result.calls.some((call) => call.includes('up'))).toBe(false);
        expect(result.errors.join('\n')).toContain('Restore Docker');
        expect(result.errors.join('\n')).toContain('coordinated maintenance cutover');
      }
    }
  );

  it.each([true, false])('succeeds with selected Docker (container running: %s)', async (running) => {
    const result = await runSetup({ running });
    expect(result.exitCode).toBe(0);
    expect(result.calls.every(([command]) => command === 'docker')).toBe(true);
    expect(result.calls.some((call) => call.includes('up'))).toBe(!running);
    expect(result.calls.some((call) => call.includes('pg_isready'))).toBe(true);
    expect(result.calls.some((call) => call.includes('psql'))).toBe(true);
  });

  it.each([true, false])('succeeds with explicitly selected native (already ready: %s)', async (nativeReady) => {
    const result = await runSetup({ mode: 'native', nativeReady });
    expect(result.exitCode).toBe(0);
    expect(result.calls.some(([command]) => command === 'docker')).toBe(false);
    expect(result.calls.some((call) => call.includes('setup-native'))).toBe(!nativeReady);
  });
});
