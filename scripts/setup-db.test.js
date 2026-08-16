import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  parseDockerPort,
  parseNativePort,
  resolveStorageMenuChoice,
} from './lib/setupDbChoice.js';

const here = dirname(fileURLToPath(import.meta.url));
const setupDbSrc = readFileSync(join(here, 'setup-db.js'), 'utf8');

describe('setup-db menu choice resolver (Phase 1: Postgres mandatory)', () => {
  it('maps "2" to native', () => {
    expect(resolveStorageMenuChoice('2')).toBe('native');
    expect(resolveStorageMenuChoice('  2  ')).toBe('native');
  });

  it('maps "1" (and default/empty) to docker exit', () => {
    expect(resolveStorageMenuChoice('1')).toBe('exit');
    expect(resolveStorageMenuChoice('')).toBe('exit');
    expect(resolveStorageMenuChoice('  ')).toBe('exit');
  });

  it('no longer offers file storage as a numbered choice — "3" is not "file"', () => {
    expect(resolveStorageMenuChoice('3')).not.toBe('file');
    expect(resolveStorageMenuChoice('3')).toBe('exit');
    expect(resolveStorageMenuChoice('file')).toBe('exit');
  });

  it('setup-db.js prompts [1/2] and never resolves "file"', () => {
    expect(setupDbSrc).toContain('Enter choice [1/2]:');
    expect(setupDbSrc).toContain('resolveStorageMenuChoice');
    expect(setupDbSrc).not.toMatch(/resolve\('file'\)/);
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
