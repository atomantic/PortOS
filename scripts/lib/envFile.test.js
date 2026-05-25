import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseEnvFile, upsertEnvKey } from './envFile.js';

let dir;
let envPath;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'envFile-test-'));
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
