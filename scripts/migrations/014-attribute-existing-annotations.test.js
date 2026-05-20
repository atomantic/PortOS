/**
 * Test for migration 014 — wrap legacy single-author annotations into the
 * multi-author shape, and crucially: lazy-create the local instance identity
 * if it's missing so we never write the literal `'unknown'` as a phantom
 * author key.
 *
 * Picked up by server/vitest.config.js's `../scripts/migrations/**\/*.test.js`
 * glob.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './014-attribute-existing-annotations.js';

describe('migration 014 — attribute existing annotations', () => {
  let rootDir;
  let dataDir;
  let annotationsPath;
  let instancesPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-014-'));
    dataDir = join(rootDir, 'data');
    mkdirSync(dataDir, { recursive: true });
    annotationsPath = join(dataDir, 'media-annotations.json');
    instancesPath = join(dataDir, 'instances.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  const writeAnnotations = (annotations) => {
    writeFileSync(annotationsPath, JSON.stringify({ annotations }, null, 2));
  };
  const readAnnotations = () => JSON.parse(readFileSync(annotationsPath, 'utf-8')).annotations;
  const writeInstances = (data) => {
    writeFileSync(instancesPath, JSON.stringify(data, null, 2));
  };
  const readInstances = () => JSON.parse(readFileSync(instancesPath, 'utf-8'));

  it('no-ops cleanly when media-annotations.json is missing', async () => {
    expect(existsSync(annotationsPath)).toBe(false);
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ changed: false, reason: 'no-annotations-file' });
    expect(existsSync(annotationsPath)).toBe(false);
    // Must NOT touch instances.json when there's nothing to migrate — a stale
    // install with no legacy notes shouldn't gain a phantom identity here.
    expect(existsSync(instancesPath)).toBe(false);
  });

  it('attributes legacy entries to existing self when instances.json has one', async () => {
    writeInstances({
      self: { instanceId: 'real-uuid-1234', name: 'workstation' },
      peers: [],
    });
    writeAnnotations({
      'image:foo.png': { starred: true, note: 'love it', updatedAt: '2025-01-01T00:00:00.000Z' },
    });
    const result = await migration.up({ rootDir });
    expect(result).toMatchObject({ changed: true, migrated: 1 });
    const out = readAnnotations();
    expect(out['image:foo.png'].authors).toEqual({
      'real-uuid-1234': {
        authorName: 'workstation',
        starred: true,
        note: 'love it',
        updatedAt: '2025-01-01T00:00:00.000Z',
      },
    });
  });

  it('lazy-creates self identity when instances.json is missing — never writes "unknown"', async () => {
    expect(existsSync(instancesPath)).toBe(false);
    writeAnnotations({
      'image:foo.png': { starred: true, note: 'old note', updatedAt: '2025-01-01T00:00:00.000Z' },
    });
    await migration.up({ rootDir });

    // instances.json must now exist with a real uuid (never "unknown") and a
    // hostname-shaped name.
    expect(existsSync(instancesPath)).toBe(true);
    const instances = readInstances();
    expect(instances.self).toBeTruthy();
    expect(instances.self.instanceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(instances.self.instanceId).not.toBe('unknown');
    expect(typeof instances.self.name).toBe('string');
    expect(instances.self.name.length).toBeGreaterThan(0);

    // The annotation must be attributed to the freshly-created identity, not "unknown".
    const out = readAnnotations();
    const authorKeys = Object.keys(out['image:foo.png'].authors);
    expect(authorKeys).toEqual([instances.self.instanceId]);
    expect(authorKeys).not.toContain('unknown');
  });

  it('lazy-creates self identity when instances.json exists but self is null', async () => {
    writeInstances({ self: null, peers: [{ id: 'peer-1', name: 'preserved' }] });
    writeAnnotations({
      'image:foo.png': { starred: true, updatedAt: '2025-01-01T00:00:00.000Z' },
    });
    await migration.up({ rootDir });

    const instances = readInstances();
    expect(instances.self.instanceId).not.toBe('unknown');
    // Preserves the pre-existing peers list rather than blowing it away.
    expect(instances.peers).toEqual([{ id: 'peer-1', name: 'preserved' }]);

    const out = readAnnotations();
    expect(Object.keys(out['image:foo.png'].authors)).toContain(instances.self.instanceId);
  });

  it('leaves entries already in multi-author shape untouched (idempotent)', async () => {
    writeInstances({
      self: { instanceId: 'real-uuid', name: 'host' },
      peers: [],
    });
    writeAnnotations({
      'image:already-current.png': {
        authors: {
          'real-uuid': { authorName: 'host', starred: true, note: '', updatedAt: '2026-01-01T00:00:00.000Z' },
        },
      },
    });
    const before = readFileSync(annotationsPath, 'utf-8');
    const result = await migration.up({ rootDir });
    expect(result).toMatchObject({ changed: false, alreadyCurrent: 1 });
    const after = readFileSync(annotationsPath, 'utf-8');
    expect(after).toBe(before); // bit-for-bit unchanged
  });

  it('skips legacy entries that are empty (neither starred nor note)', async () => {
    writeInstances({ self: { instanceId: 'real-uuid', name: 'host' }, peers: [] });
    writeAnnotations({
      'image:hollow.png': { starred: false, note: '', updatedAt: '2026-01-01T00:00:00.000Z' },
      'image:keep.png': { starred: true, updatedAt: '2026-01-01T00:00:00.000Z' },
    });
    await migration.up({ rootDir });
    const out = readAnnotations();
    expect(out['image:hollow.png']).toBeUndefined();
    expect(out['image:keep.png']).toBeDefined();
  });

  it('rejects existing self.instanceId === "unknown" and creates a fresh identity', async () => {
    // The whole point of this migration fix is to never persist the literal
    // 'unknown' string as an author key. If a previous run (or hand-edit) left
    // self.instanceId === 'unknown', the migration must replace it with a real
    // uuid — otherwise we'd re-attribute legacy entries to the phantom again.
    writeInstances({ self: { instanceId: 'unknown', name: 'old-host' }, peers: [] });
    writeAnnotations({
      'image:foo.png': { starred: true, updatedAt: '2025-01-01T00:00:00.000Z' },
    });
    await migration.up({ rootDir });
    const instances = readInstances();
    expect(instances.self.instanceId).not.toBe('unknown');
    expect(instances.self.instanceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const out = readAnnotations();
    expect(Object.keys(out['image:foo.png'].authors)).toEqual([instances.self.instanceId]);
  });

  it('rejects non-string self.instanceId (numeric) and creates a fresh identity', async () => {
    writeInstances({ self: { instanceId: 42, name: 'host' }, peers: [] });
    writeAnnotations({
      'image:foo.png': { starred: true, updatedAt: '2025-01-01T00:00:00.000Z' },
    });
    await migration.up({ rootDir });
    const instances = readInstances();
    expect(typeof instances.self.instanceId).toBe('string');
    expect(instances.self.instanceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('rejects whitespace-only or padded "unknown" sentinel and creates a fresh identity', async () => {
    // A hand-edited or whitespace-corrupted instances.json mustn't slip past
    // the sentinel guard — `'  unknown  '` is the same phantom as `'unknown'`.
    writeInstances({ self: { instanceId: '   unknown   ', name: 'old' }, peers: [] });
    writeAnnotations({
      'image:foo.png': { starred: true, updatedAt: '2025-01-01T00:00:00.000Z' },
    });
    await migration.up({ rootDir });
    const instances = readInstances();
    expect(instances.self.instanceId.trim()).not.toBe('unknown');
    expect(instances.self.instanceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('rejects whitespace-only self.instanceId and creates a fresh identity', async () => {
    writeInstances({ self: { instanceId: '   ', name: 'host' }, peers: [] });
    writeAnnotations({
      'image:foo.png': { starred: true, updatedAt: '2025-01-01T00:00:00.000Z' },
    });
    await migration.up({ rootDir });
    const instances = readInstances();
    expect(instances.self.instanceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('rejects empty-string self.instanceId and creates a fresh identity', async () => {
    writeInstances({ self: { instanceId: '', name: 'host' }, peers: [] });
    writeAnnotations({
      'image:foo.png': { starred: true, updatedAt: '2025-01-01T00:00:00.000Z' },
    });
    await migration.up({ rootDir });
    const instances = readInstances();
    expect(instances.self.instanceId.length).toBeGreaterThan(0);
    expect(instances.self.instanceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('tolerates corrupt instances.json — treats as missing and creates a fresh identity', async () => {
    // The in-server reader (safeJSONParse) tolerates malformed JSON; the
    // migration must match that behavior, otherwise a hand-edited or
    // half-written instances.json would brick boot.
    writeFileSync(instancesPath, '{ this is not valid JSON');
    writeAnnotations({
      'image:foo.png': { starred: true, updatedAt: '2025-01-01T00:00:00.000Z' },
    });
    await expect(migration.up({ rootDir })).resolves.not.toThrow();
    const instances = readInstances();
    expect(instances.self.instanceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('is idempotent — re-running over already-migrated data is a no-op', async () => {
    writeInstances({ self: { instanceId: 'real-uuid', name: 'host' }, peers: [] });
    writeAnnotations({
      'image:foo.png': { starred: true, updatedAt: '2025-01-01T00:00:00.000Z' },
    });
    await migration.up({ rootDir });
    const afterFirst = readFileSync(annotationsPath, 'utf-8');
    await migration.up({ rootDir });
    const afterSecond = readFileSync(annotationsPath, 'utf-8');
    expect(afterSecond).toBe(afterFirst);
  });
});
