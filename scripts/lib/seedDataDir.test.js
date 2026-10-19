import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { seedDataDir } from './seedDataDir.js';

describe('seedDataDir migration safety', () => {
  let root;
  let referenceDir;
  let dataDir;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'portos-seed-data-'));
    referenceDir = join(root, 'data.reference');
    dataDir = join(root, 'data');
    mkdirSync(join(referenceDir, 'cos'), { recursive: true });
    // Simulate an accidentally reintroduced seed for migration 339's output.
    writeFileSync(join(referenceDir, 'cos/config.json'), 'shipped default');
    writeFileSync(join(referenceDir, 'cos/starter.json'), 'starter content');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it.each(['fresh', 'existing'])('never creates a migration-owned file in a %s install', (install) => {
    if (install === 'existing') mkdirSync(dataDir);
    seedDataDir({ referenceDir, dataDir });
    expect(existsSync(join(dataDir, 'cos/config.json'))).toBe(false);
  });

  it('preserves the bytes of an existing migration-owned file', () => {
    mkdirSync(join(dataDir, 'cos'), { recursive: true });
    const original = Buffer.from([0, 255, 10, 123, 125]);
    writeFileSync(join(dataDir, 'cos/config.json'), original);
    seedDataDir({ referenceDir, dataDir });
    expect(readFileSync(join(dataDir, 'cos/config.json'))).toEqual(original);
  });

  it('copies a missing ordinary file without replacing customized content on upgrade', () => {
    mkdirSync(join(dataDir, 'cos'), { recursive: true });
    writeFileSync(join(referenceDir, 'cos/custom.json'), 'shipped customization');
    writeFileSync(join(dataDir, 'cos/custom.json'), 'user customization');
    seedDataDir({ referenceDir, dataDir });
    expect(readFileSync(join(dataDir, 'cos/starter.json'), 'utf8')).toBe('starter content');
    expect(readFileSync(join(dataDir, 'cos/custom.json'), 'utf8')).toBe('user customization');
  });
});
