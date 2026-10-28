import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, copyFileSync, rmSync } from 'fs';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseEnvFile, upsertEnvKey } from './envFile.js';

const tempDirs = [];

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'envFile-test-'));
  tempDirs.push(dir);
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

let dir;
let envPath;

beforeEach(() => {
  dir = tempDirs[tempDirs.length - 1];
  envPath = join(dir, '.env');
});

describe('parseEnvFile', () => {
  it('returns {} when file is missing', () => {
    expect(parseEnvFile(join(dir, 'nonexistent.env'))).toEqual({});
  });

  it('parses simple KEY=value pairs', () => {
    writeFileSync(envPath, 'FOO=bar\nBAZ=qux\n');
    expect(parseEnvFile(envPath)).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('skips blank lines and # comments', () => {
    writeFileSync(envPath, '# comment\n\nFOO=bar\n');
    expect(parseEnvFile(envPath)).toEqual({ FOO: 'bar' });
  });

  it('strips double-quoted values', () => {
    writeFileSync(envPath, 'FOO="hello world"\n');
    expect(parseEnvFile(envPath)).toEqual({ FOO: 'hello world' });
  });

  it('strips single-quoted values', () => {
    writeFileSync(envPath, "FOO='hello world'\n");
    expect(parseEnvFile(envPath)).toEqual({ FOO: 'hello world' });
  });

  it('does not strip mismatched quotes', () => {
    writeFileSync(envPath, "FOO='mismatched\"\n");
    expect(parseEnvFile(envPath)).toEqual({ FOO: "'mismatched\"" });
  });

  it('trims whitespace around key and value', () => {
    writeFileSync(envPath, '  KEY  =  val  \n');
    expect(parseEnvFile(envPath)).toEqual({ KEY: 'val' });
  });

  it('handles first = only when multiple = present', () => {
    writeFileSync(envPath, 'URL=http://a=b\n');
    expect(parseEnvFile(envPath)).toEqual({ URL: 'http://a=b' });
  });
});

describe('pre-install module boundary', () => {
  it('loads the CommonJS parser without any installed dependency', async () => {
    const { createRequire } = await import('module');
    const cjs = createRequire(import.meta.url)('./envFile.cjs');
    expect(Object.keys(cjs).sort()).toEqual(['DEFAULT_HTTP_MIRROR_PORT', 'parseEnvContent', 'parseEnvFile', 'resolveHttpMirrorPort']);
    expect(cjs.parseEnvContent('A = "x y"\r\nB=\'z\'\n')).toEqual({ A: 'x y', B: 'z' });
  });
});

describe('upsertEnvKey', () => {
  it('creates .env with the key when file is missing', () => {
    upsertEnvKey(envPath, 'PGMODE', 'docker');
    expect(parseEnvFile(envPath)).toMatchObject({ PGMODE: 'docker' });
  });

  it('prepends when key is absent', () => {
    writeFileSync(envPath, 'OTHER=val\n');
    upsertEnvKey(envPath, 'PGMODE', 'native');
    const parsed = parseEnvFile(envPath);
    expect(parsed).toMatchObject({ PGMODE: 'native', OTHER: 'val' });
  });

  it('replaces existing key in-place', () => {
    writeFileSync(envPath, 'OTHER=val\nPGMODE=docker\nMORE=x\n');
    upsertEnvKey(envPath, 'PGMODE', 'native');
    const parsed = parseEnvFile(envPath);
    expect(parsed).toMatchObject({ PGMODE: 'native', OTHER: 'val', MORE: 'x' });
  });

  it('does not duplicate the key', () => {
    writeFileSync(envPath, 'PGMODE=docker\n');
    upsertEnvKey(envPath, 'PGMODE', 'native');
    upsertEnvKey(envPath, 'PGMODE', 'file');
    const parsed = parseEnvFile(envPath);
    expect(Object.keys(parsed).filter(k => k === 'PGMODE')).toHaveLength(1);
    expect(parsed.PGMODE).toBe('file');
  });

  it('upserts LLM_BACKEND correctly', () => {
    upsertEnvKey(envPath, 'LLM_BACKEND', 'ollama');
    upsertEnvKey(envPath, 'LLM_BACKEND', 'lmstudio');
    expect(parseEnvFile(envPath)).toMatchObject({ LLM_BACKEND: 'lmstudio' });
  });

  it('writes values containing $ literally (no String.replace pattern interpretation)', () => {
    upsertEnvKey(envPath, 'PGPASSWORD', 'placeholder');
    // $$ , $& , $1 would all be mangled by a string replacement arg.
    upsertEnvKey(envPath, 'PGPASSWORD', 'p$$ass$&w$1ord');
    expect(parseEnvFile(envPath)).toMatchObject({ PGPASSWORD: 'p$$ass$&w$1ord' });
  });
});

// Uniquely catches setup reporting success after an unreadable existing .env
// was treated as empty and overwritten, even when writing is permitted.
describe('interactive setup read failure', () => {
  it('surfaces a failed read without opening the existing configuration for writing', () => {
    const scriptsDir = join(dir, 'scripts');
    mkdirSync(join(scriptsDir, 'lib'), { recursive: true });
    for (const relative of ['setup-llm.js', 'lib/envFile.js', 'lib/envFile.cjs']) {
      copyFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), join(scriptsDir, relative));
    }
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    const original = 'UNRELATED=synthetic-marker\n';
    writeFileSync(envPath, original);
    const preload = join(dir, 'inject-read-failure.mjs');
    writeFileSync(preload, `
      import fs from 'node:fs';
      import readline from 'node:readline';
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      const read = fs.readFileSync;
      const write = fs.writeFileSync;
      fs.readFileSync = (path, ...args) => {
        if (String(path).endsWith('/.env')) throw Object.assign(new Error('synthetic read denied'), { code: 'EACCES' });
        return read(path, ...args);
      };
      fs.writeFileSync = (path, ...args) => {
        if (String(path).endsWith('/.env')) process.stderr.write('ENV_WRITE_ATTEMPT\\n');
        return write(path, ...args);
      };
      Object.defineProperty(process.stdin, 'isTTY', { value: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: true });
      readline.createInterface = () => ({ question: (_, answer) => answer('1'), close() {} });
      childProcess.execFileSync = () => Buffer.from('synthetic installed command');
      delete process.env.LLM_BACKEND;
      syncBuiltinESMExports();
    `);
    const result = spawnSync(process.execPath, ['--import', preload, join(scriptsDir, 'setup-llm.js')], { encoding: 'utf8' });
    expect(result.error).toBeUndefined();
    expect(result.status, JSON.stringify(result)).not.toBe(0);
    expect(result.stderr).toContain('synthetic read denied');
    expect(result.stderr).not.toContain('ENV_WRITE_ATTEMPT');
    expect(result.stdout).not.toContain('Local LLM backend set to');
    expect(readFileSync(envPath, 'utf8')).toBe(original);
  });
});
