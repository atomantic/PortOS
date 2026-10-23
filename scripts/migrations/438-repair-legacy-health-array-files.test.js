import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './438-repair-legacy-health-array-files.js';

describe('migration 438 — legacy bare-array health files', () => {
  let rootDir, dir;
  const p = (name) => join(dir, name);
  const put = (name, value) => writeFileSync(p(name), typeof value === 'string' ? value : JSON.stringify(value));
  const read = (name) => JSON.parse(readFileSync(p(name), 'utf-8'));

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-438-'));
    dir = join(rootDir, 'data', 'meatspace');
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('does nothing when no health files exist', async () => {
    await migration.up({ rootDir });
    expect(existsSync(p('eyes.json'))).toBe(false);
  });

  it('wraps every known legacy array in its reader contract, keeping rows and a backup', async () => {
    const eyes = [{ id: 'e1', date: '2024-01-02', od: -1 }, { id: 'e2', date: '2024-06-01', od: -1.25 }];
    const epi = [{ id: 'p1', date: '2024-03-01', biologicalAge: 40 }];
    const metrics = [{ date: '2024-02-01', bloodPressureSystolic: 120, bloodPressureDiastolic: 80 }];
    put('eyes.json', eyes);
    put('epigenetic-tests.json', epi);
    put('health-metrics.json', metrics);
    const original = readFileSync(p('eyes.json'));

    await migration.up({ rootDir });

    expect(read('eyes.json')).toEqual({ exams: eyes });
    expect(read('epigenetic-tests.json')).toEqual({ tests: epi });
    expect(read('health-metrics.json')).toEqual({ entries: metrics });
    expect(readFileSync(p('eyes.json.pre-438.json')).equals(original)).toBe(true);
  });

  it('flattens nested blood markers, keeping id, date and other fields', async () => {
    put('blood-tests.json', [
      { id: 'b1', date: '2024-01-01', lab: 'Acme', createdAt: 't', markers: { glucose: 90, ldl: 100 } },
      { id: 'b2', date: '2024-02-01', hdl: 55 },
      { id: 'b3', date: '2024-03-01', markers: null },
    ]);
    await migration.up({ rootDir });
    expect(read('blood-tests.json')).toEqual({
      tests: [
        { id: 'b1', date: '2024-01-01', lab: 'Acme', createdAt: 't', glucose: 90, ldl: 100 },
        { id: 'b2', date: '2024-02-01', hdl: 55 },
        { id: 'b3', date: '2024-03-01' },
      ],
      referenceRanges: {},
    });
  });

  it('leaves valid wrappers (and their unknown metadata) byte-for-byte unchanged', async () => {
    const wrapped = '{"exams":[{"id":"e1","date":"2024-01-01"}],"_rowTombstones":{"x":1}}';
    put('eyes.json', wrapped);
    put('blood-tests.json', { tests: [], referenceRanges: { glucose: [70, 99] } });
    const before = readFileSync(p('blood-tests.json'));
    await migration.up({ rootDir });
    expect(readFileSync(p('eyes.json'), 'utf-8')).toBe(wrapped);
    expect(readFileSync(p('blood-tests.json')).equals(before)).toBe(true);
    expect(existsSync(p('eyes.json.pre-438.json'))).toBe(false);
  });

  it('refuses malformed JSON, non-object rows and ambiguous markers without overwriting', async () => {
    put('eyes.json', '[{"id":"e1"');
    put('epigenetic-tests.json', [{ id: 'p1' }, 'stray']);
    put('blood-tests.json', [{ id: 'b1', lab: 'Acme', markers: { lab: 'clash' } }]);
    put('health-metrics.json', '"just a string"');
    const before = ['eyes.json', 'epigenetic-tests.json', 'blood-tests.json', 'health-metrics.json']
      .map((name) => [name, readFileSync(p(name), 'utf-8')]);

    await migration.up({ rootDir });

    for (const [name, text] of before) expect(readFileSync(p(name), 'utf-8')).toBe(text);
    expect(existsSync(p('eyes.json.pre-438.json'))).toBe(false);
    expect(existsSync(p('blood-tests.json.pre-438.json'))).toBe(false);
    put('blood-tests.json', [{ id: 'b2', markers: { id: 'clash' } }]);
    await migration.up({ rootDir });
    expect(read('blood-tests.json')).toEqual([{ id: 'b2', markers: { id: 'clash' } }]);
  });

  it('is safe to repeat and resumes after an interruption that left only the backup', async () => {
    const rows = [{ id: 'e1', date: '2024-01-01' }];
    put('eyes.json', rows);
    writeFileSync(p('eyes.json.pre-438.json'), readFileSync(p('eyes.json'))); // crash after backup, before swap

    await migration.up({ rootDir });
    const once = readFileSync(p('eyes.json'), 'utf-8');
    expect(JSON.parse(once)).toEqual({ exams: rows });

    await migration.up({ rootDir });
    expect(readFileSync(p('eyes.json'), 'utf-8')).toBe(once);
  });

  it('refuses when a different backup already occupies the backup path', async () => {
    put('eyes.json', [{ id: 'e1' }]);
    writeFileSync(p('eyes.json.pre-438.json'), 'someone else');
    await migration.up({ rootDir });
    expect(read('eyes.json')).toEqual([{ id: 'e1' }]);
    expect(readFileSync(p('eyes.json.pre-438.json'), 'utf-8')).toBe('someone else');
  });

  it.skipIf(process.getuid?.() === 0)('fails (to be retried) on an unreadable file while still repairing the others', async () => {
    put('eyes.json', [{ id: 'e1' }]);
    put('health-metrics.json', [{ date: '2024-01-01' }]);
    chmodSync(p('eyes.json'), 0o000);
    try {
      await expect(migration.up({ rootDir })).rejects.toThrow(/eyes\.json/);
    } finally { chmodSync(p('eyes.json'), 0o600); }
    expect(read('health-metrics.json')).toEqual({ entries: [{ date: '2024-01-01' }] });
    expect(read('eyes.json')).toEqual([{ id: 'e1' }]);
  });
});
