import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import issuesMigration from './035-split-pipeline-issues-to-per-id.js';
import seriesMigration from './036-split-pipeline-series-to-per-id.js';

// Lets a test fail directory listings (EIO) while every other fs call is real.
const fault = vi.hoisted(() => ({ readdirFails: false }));
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readdir: (...args) => {
      if (fault.readdirFails) return Promise.reject(Object.assign(new Error('EIO: i/o error, scandir'), { code: 'EIO' }));
      return actual.readdir(...args);
    },
  };
});

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

const cases = [
  {
    name: 'issues',
    migration: issuesMigration,
    legacyFile: 'pipeline-issues.json',
    backupSuffix: '.bak-035',
    typeDir: 'pipeline-issues',
    type: 'pipelineIssues',
    key: 'issues',
    validId: 'iss-alpha',
    otherId: 'iss-beta',
    invalidId: 'bad',
  },
  {
    name: 'series',
    migration: seriesMigration,
    legacyFile: 'pipeline-series.json',
    backupSuffix: '.bak-036',
    typeDir: 'pipeline-series',
    type: 'pipelineSeries',
    key: 'series',
    validId: 'ser-alpha',
    otherId: 'ser-beta',
    invalidId: 'bad',
  },
];

describe.each(cases)('migration split pipeline $name', (cfg) => {
  let rootDir;
  let dataDir;
  let legacyPath;
  let typeDir;
  let typeIndexPath;
  let backupPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), `migration-${cfg.name}-`));
    dataDir = join(rootDir, 'data');
    mkdirSync(dataDir, { recursive: true });
    legacyPath = join(dataDir, cfg.legacyFile);
    typeDir = join(dataDir, cfg.typeDir);
    typeIndexPath = join(typeDir, 'index.json');
    backupPath = legacyPath + cfg.backupSuffix;
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('fresh install stamps an empty type index', async () => {
    const result = await cfg.migration.up({ rootDir });
    expect(result).toEqual({ ok: true, reason: 'fresh-install' });
    const idx = readJson(typeIndexPath);
    expect(idx).toMatchObject({ schemaVersion: 1, type: cfg.type, config: {} });
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(backupPath)).toBe(false);
  });

  it('splits each valid record and backs up the legacy file', async () => {
    writeJson(legacyPath, {
      [cfg.key]: [
        { id: cfg.validId, name: 'Alpha', title: 'Alpha' },
        { id: cfg.otherId, name: 'Beta', title: 'Beta' },
      ],
    });

    const result = await cfg.migration.up({ rootDir });
    expect(result).toEqual({ ok: true, reason: 'split', written: 2, skipped: 0, invalid: 0 });
    expect(readJson(typeIndexPath).schemaVersion).toBe(1);
    expect(readJson(join(typeDir, cfg.validId, 'index.json')).id).toBe(cfg.validId);
    expect(readJson(join(typeDir, cfg.otherId, 'index.json')).id).toBe(cfg.otherId);
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(backupPath)).toBe(true);
  });

  it('recovers partial splits without clobbering already-split records', async () => {
    writeJson(legacyPath, {
      [cfg.key]: [
        { id: cfg.validId, name: 'Legacy', title: 'Legacy' },
        { id: cfg.otherId, name: 'Other', title: 'Other' },
      ],
    });
    mkdirSync(join(typeDir, cfg.validId), { recursive: true });
    writeJson(join(typeDir, cfg.validId, 'index.json'), { id: cfg.validId, name: 'Newer', title: 'Newer' });

    const result = await cfg.migration.up({ rootDir });
    expect(result).toEqual({ ok: true, reason: 'split', written: 1, skipped: 1, invalid: 0 });
    const preserved = readJson(join(typeDir, cfg.validId, 'index.json'));
    expect(preserved.name || preserved.title).toBe('Newer');
    expect(existsSync(join(typeDir, cfg.otherId, 'index.json'))).toBe(true);
  });

  it('aborts without mutating anything when the existing-record directory cannot be listed, then recovers on retry', async () => {
    writeJson(legacyPath, {
      [cfg.key]: [
        { id: cfg.validId, name: 'Legacy', title: 'Legacy' },
        { id: cfg.otherId, name: 'Other', title: 'Other' },
      ],
    });
    mkdirSync(join(typeDir, cfg.validId), { recursive: true });
    const newerPath = join(typeDir, cfg.validId, 'index.json');
    writeJson(newerPath, { id: cfg.validId, name: 'Newer', title: 'Newer' });
    const newerBytes = readFileSync(newerPath);
    const legacyBytes = readFileSync(legacyPath);

    fault.readdirFails = true;
    try {
      await expect(cfg.migration.up({ rootDir })).rejects.toThrow(/EIO/);
    } finally {
      fault.readdirFails = false;
    }
    expect(readFileSync(newerPath).equals(newerBytes)).toBe(true);
    expect(readFileSync(legacyPath).equals(legacyBytes)).toBe(true);
    expect(existsSync(typeIndexPath)).toBe(false);
    expect(existsSync(join(typeDir, cfg.otherId, 'index.json'))).toBe(false);
    expect(existsSync(backupPath)).toBe(false);

    const retry = await cfg.migration.up({ rootDir });
    expect(retry).toEqual({ ok: true, reason: 'split', written: 1, skipped: 1, invalid: 0 });
    expect(readFileSync(newerPath).equals(newerBytes)).toBe(true);
    expect(existsSync(join(typeDir, cfg.otherId, 'index.json'))).toBe(true);
  });

  it('skips invalid ids and rejects unreadable legacy files', async () => {
    writeJson(legacyPath, { [cfg.key]: [{ id: cfg.validId }, { id: cfg.invalidId }, null] });
    const split = await cfg.migration.up({ rootDir });
    expect(split.written).toBe(1);
    expect(split.invalid).toBe(2);

    rmSync(rootDir, { recursive: true, force: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(legacyPath, 'not json');
    await expect(cfg.migration.up({ rootDir })).rejects.toThrow(/unreadable/);
  });
});
