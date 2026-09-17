import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import migration from './393-remove-retired-productivity-store.js';

describe('migration 393 — remove the retired productivity store', () => {
  let rootDir;
  let cosDir;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-393-productivity-'));
    cosDir = join(rootDir, 'data', 'cos');
    mkdirSync(cosDir, { recursive: true });
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('removes the orphaned aggregate and leaves the agent history it was derived from', async () => {
    const productivity = join(cosDir, 'productivity.json');
    // The real index the calendar now reads instead — data/cos/agents/index.json.
    const agentsIndex = join(cosDir, 'agents', 'index.json');
    mkdirSync(join(cosDir, 'agents'), { recursive: true });
    writeFileSync(productivity, JSON.stringify({ dailyHistory: { '2026-01-02': { tasks: 3 } } }));
    writeFileSync(agentsIndex, JSON.stringify({ 'agent-1': '2026-01-02' }));

    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 1 });

    expect(existsSync(productivity)).toBe(false);
    expect(JSON.parse(readFileSync(agentsIndex, 'utf8'))).toEqual({ 'agent-1': '2026-01-02' });
  });

  it('no-ops on an install that never wrote the store, and on a re-run', async () => {
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'no-productivity-store' });

    writeFileSync(join(cosDir, 'productivity.json'), '{}');
    await migration.up({ rootDir });
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'no-productivity-store' });
  });
});
