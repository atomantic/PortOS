/**
 * Document, genome and ChatGPT-import writes against a backup cut (#9982): a
 * file-plus-record mutation requested while a cut is copying waits for it, so
 * the copy never sees bytes the record does not name (or the reverse).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';

const tempRoot = mkdtempSync(join(tmpdir(), 'portos-archive-backup-boot-'));
const bootRoot = tempRoot;

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makePathsProxy(actual, { dataRoot: () => tempRoot });
});
vi.mock('../lib/databaseMaintenanceJournal.js', async (importOriginal) => ({
  ...(await importOriginal()),
  assertDatabaseAdmission: () => {},
}));

const { acquireBackupSnapshotCut } = await import('../lib/backupSnapshotBoundary.js');
const { uploadGenome, deleteGenome } = await import('./genome.js');
const { createDocument } = await import('./digital-twin-documents.js');

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
const snps = Array.from({ length: 120 }, (_, i) => `rs${1000 + i}\t1\t${100 + i}\tAA`).join('\n');

describe('archive and document owners against a backup cut', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(join(tempRoot, 'digital-twin'), { recursive: true, force: true });
    rmSync(join(tempRoot, 'meatspace'), { recursive: true, force: true });
  });
  afterAll(() => rmSync(bootRoot, { recursive: true, force: true }));

  it('lands a genome upload and removes it only outside a cut', async () => {
    const raw = join(tempRoot, 'meatspace', 'genome-raw.txt');
    const release = await acquireBackupSnapshotCut();
    let upload;
    try {
      upload = uploadGenome(snps, 'example.txt');
      await settle();
      expect(existsSync(raw)).toBe(false);
    } finally {
      release();
    }
    await upload;
    expect(existsSync(raw)).toBe(true);

    const second = await acquireBackupSnapshotCut();
    let removal;
    try {
      removal = deleteGenome();
      await settle();
      expect(existsSync(raw)).toBe(true);
    } finally {
      second();
    }
    await removal;
    expect(existsSync(raw)).toBe(false);
  });

  it('writes a digital twin document file only after the cut releases', async () => {
    const release = await acquireBackupSnapshotCut();
    let created;
    try {
      created = createDocument({ filename: 'example-doc.md', title: 'Example', category: 'core', content: '# Example' });
      await settle();
      expect(existsSync(join(tempRoot, 'digital-twin', 'example-doc.md'))).toBe(false);
    } finally {
      release();
    }
    await created;
    expect(existsSync(join(tempRoot, 'digital-twin', 'example-doc.md'))).toBe(true);
  });
});
