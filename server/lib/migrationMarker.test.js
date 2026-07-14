import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makePathsProxy } from './mockPathsDataRoot.js';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'migration-marker-test-'));

// Redirect PATHS.data at the temp dir; keep the real tryReadFile/atomicWrite/
// safeJSONParse so the helpers do genuine on-disk I/O against the temp root.
vi.mock('./fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return makePathsProxy(actual, { dataRoot: TEST_DATA_ROOT });
});

const { markerExists, readMarker, writeMarker } = await import('./migrationMarker.js');

afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

const markerFile = (name) => join(TEST_DATA_ROOT, name);

describe('migrationMarker', () => {
  beforeEach(() => {
    rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
    mkdirSync(TEST_DATA_ROOT, { recursive: true });
  });

  describe('markerExists', () => {
    it('returns false when the marker file is absent', async () => {
      expect(await markerExists('absent.migrated.json')).toBe(false);
    });

    it('returns true when the marker file exists (even if empty)', async () => {
      writeFileSync(markerFile('present.migrated.json'), '');
      expect(await markerExists('present.migrated.json')).toBe(true);
    });

    it('returns true for a non-JSON marker (gate is presence, not validity)', async () => {
      writeFileSync(markerFile('garbage.applied.json'), 'not json at all');
      expect(await markerExists('garbage.applied.json')).toBe(true);
    });
  });

  describe('readMarker', () => {
    it('returns null when the marker file is absent', async () => {
      expect(await readMarker('absent.applied.json')).toBeNull();
    });

    it('returns null for an empty marker file', async () => {
      writeFileSync(markerFile('empty.applied.json'), '');
      expect(await readMarker('empty.applied.json')).toBeNull();
    });

    it('returns null for an invalid-JSON marker instead of throwing', async () => {
      writeFileSync(markerFile('broken.applied.json'), '{ not: valid');
      expect(await readMarker('broken.applied.json')).toBeNull();
    });

    it('returns the parsed payload for a valid JSON marker', async () => {
      const payload = { version: 2, appliedAt: '2026-01-01T00:00:00.000Z', scanned: 7 };
      writeFileSync(markerFile('valid.applied.json'), JSON.stringify(payload));
      expect(await readMarker('valid.applied.json')).toEqual(payload);
    });
  });

  describe('writeMarker', () => {
    it('writes pretty-printed JSON that round-trips through readMarker', async () => {
      const payload = { migratedAt: '2026-02-02T00:00:00.000Z', imported: 3, skipped: 1, reason: 'imported' };
      await writeMarker('roundtrip.migrated.json', payload);

      // Persisted as 2-space pretty JSON.
      const raw = readFileSync(markerFile('roundtrip.migrated.json'), 'utf-8');
      expect(raw).toBe(JSON.stringify(payload, null, 2));

      expect(await markerExists('roundtrip.migrated.json')).toBe(true);
      expect(await readMarker('roundtrip.migrated.json')).toEqual(payload);
    });

    it('overwrites an existing marker with the new payload', async () => {
      await writeMarker('overwrite.applied.json', { version: 1 });
      await writeMarker('overwrite.applied.json', { version: 2, extra: true });
      expect(await readMarker('overwrite.applied.json')).toEqual({ version: 2, extra: true });
    });

    it('creates the marker atomically (no leftover temp files in data/)', async () => {
      await writeMarker('atomic.migrated.json', { ok: true });
      expect(existsSync(markerFile('atomic.migrated.json'))).toBe(true);
      // atomicWrite renames its temp file into place — none should linger.
      const { readdirSync } = await import('fs');
      const leftovers = readdirSync(TEST_DATA_ROOT).filter((f) => f.includes('.tmp'));
      expect(leftovers).toEqual([]);
    });
  });
});
