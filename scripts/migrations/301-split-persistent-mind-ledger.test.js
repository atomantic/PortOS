import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import migration, { splitPersistentMindLedger } from './301-split-persistent-mind-ledger.js';

const line = (value) => `${JSON.stringify(value)}\n`;

describe('migration 301 — split persistent mind ledger', () => {
  let rootDir;
  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-301-'));
    mkdirSync(join(rootDir, 'data', 'cos'), { recursive: true });
  });
  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('moves mind events, preserves ordinary and corrupt lines, and records predecessor provenance', () => {
    const result = splitPersistentMindLedger({
      runArchive: `${line({ eventId: 'run-1', kind: 'run.spawned' })}${line({ eventId: 'mind-1', kind: 'mind.wake', mindId: 'mind', sequence: 100, data: {} })}`,
      runActive: `not-json\n${line({ eventId: 'mind-2', kind: 'mind.turn.completed', mindId: 'mind', sequence: 9000, data: {} })}`,
    });
    expect(result.runArchive).toContain('run.spawned');
    expect(result.runActive).toBe('not-json\n');
    expect(result.mindArchive).toContain('"previousSequence":null');
    expect(result.mindActive).toContain('"previousSequence":100');
    expect(result.moved).toBe(2);
  });

  it('writes the split idempotently through the migration entrypoint', async () => {
    const cosDir = join(rootDir, 'data', 'cos');
    writeFileSync(join(cosDir, 'run-events.jsonl'), `${line({ eventId: 'run-1', kind: 'run.spawned' })}${line({ eventId: 'mind-1', kind: 'mind.wake', mindId: 'mind', sequence: 1, data: {} })}`);
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 1 });
    expect(readFileSync(join(cosDir, 'run-events.jsonl'), 'utf8')).not.toContain('mind.wake');
    expect(readFileSync(join(cosDir, 'mind-events.jsonl'), 'utf8')).toContain('mind.wake');
    await expect(migration.up({ rootDir })).resolves.toMatchObject({ updated: 0 });
  });
});
