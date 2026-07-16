import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { up } from './191-creative-commissions.js';

let rootDir;

beforeEach(async () => { rootDir = await mkdtemp(join(tmpdir(), 'portos-mig191-')); });
afterEach(async () => { await rm(rootDir, { recursive: true, force: true }); });

const indexPath = () => join(rootDir, 'data', 'creative-commissions', 'index.json');

describe('migration 191 — creative-commissions type index stamp', () => {
  it('creates the type index at schemaVersion 1 on a fresh install', async () => {
    const res = await up({ rootDir });
    expect(res.migrated).toBe(true);
    const idx = JSON.parse(await readFile(indexPath(), 'utf-8'));
    expect(idx.schemaVersion).toBe(1);
    expect(idx.type).toBe('creative-commissions');
    expect(idx.config).toEqual({});
  });

  it('is idempotent — a second run writes nothing', async () => {
    await up({ rootDir });
    const first = await readFile(indexPath(), 'utf-8');
    const res = await up({ rootDir });
    expect(res.migrated).toBe(false);
    expect(await readFile(indexPath(), 'utf-8')).toBe(first);
  });

  it('does not downgrade an index already past v1', async () => {
    await mkdir(join(rootDir, 'data', 'creative-commissions'), { recursive: true });
    await writeFile(indexPath(), JSON.stringify({ schemaVersion: 3, type: 'creative-commissions', config: { x: 1 } }));
    const res = await up({ rootDir });
    expect(res.migrated).toBe(false);
    const idx = JSON.parse(await readFile(indexPath(), 'utf-8'));
    expect(idx.schemaVersion).toBe(3);
    expect(idx.config).toEqual({ x: 1 });
  });
});
