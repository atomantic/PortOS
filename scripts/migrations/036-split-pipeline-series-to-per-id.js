/**
 * Split `data/pipeline-series.json` into per-record files under
 * `data/pipeline-series/{id}/index.json`.
 */

import { readFile, writeFile, rename, mkdir, stat, readdir } from 'fs/promises';
import { join } from 'path';

const TYPE_DIR_NAME = 'pipeline-series';
const LEGACY_FILENAME = 'pipeline-series.json';
const BACKUP_SUFFIX = '.bak-036';
const TYPE_SCHEMA_VERSION = 1;
const TYPE_LABEL = 'pipelineSeries';
const VALID_ID = /^ser-[A-Za-z0-9-]+$/;

const fileExists = (path) => stat(path).then(() => true, (err) => {
  if (err.code === 'ENOENT') return false;
  throw err;
});

const readJsonStrict = async (path) => {
  const raw = await readFile(path, 'utf-8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (raw == null) return null;
  return JSON.parse(raw);
};

const readJsonTolerant = async (path) => {
  const raw = await readFile(path, 'utf-8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return { __unreadable: true }; }
};

const writeJson = (path, value) =>
  writeFile(path, JSON.stringify(value, null, 2) + '\n');

async function existingRecordIds(typeDir) {
  const ids = new Set();
  if (!await fileExists(typeDir)) return ids;
  const entries = await readdir(typeDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name === 'index.json' || entry.name.startsWith('.') || !entry.isDirectory()) continue;
    if (await fileExists(join(typeDir, entry.name, 'index.json'))) ids.add(entry.name);
  }
  return ids;
}

export default {
  async up({ rootDir }) {
    const dataDir = join(rootDir, 'data');
    const typeDir = join(dataDir, TYPE_DIR_NAME);
    const typeIndexPath = join(typeDir, 'index.json');
    const legacyPath = join(dataDir, LEGACY_FILENAME);
    const backupPath = legacyPath + BACKUP_SUFFIX;

    const typeIndex = await readJsonStrict(typeIndexPath);
    if (typeIndex && typeIndex.schemaVersion >= TYPE_SCHEMA_VERSION) {
      console.log(`📦 migration 036: pipeline series already at schemaVersion=${typeIndex.schemaVersion} — no-op`);
      return { ok: true, reason: 'already-applied' };
    }

    const legacyExists = await fileExists(legacyPath);
    const backupExists = await fileExists(backupPath);
    if (!legacyExists && !backupExists) {
      await mkdir(typeDir, { recursive: true });
      await writeJson(typeIndexPath, {
        schemaVersion: TYPE_SCHEMA_VERSION,
        type: TYPE_LABEL,
        updatedAt: new Date().toISOString(),
        config: {},
      });
      console.log(`📦 migration 036: fresh install — stamped data/${TYPE_DIR_NAME}/index.json @ v${TYPE_SCHEMA_VERSION}`);
      return { ok: true, reason: 'fresh-install' };
    }

    const sourcePath = legacyExists ? legacyPath : backupPath;
    const doc = await readJsonTolerant(sourcePath);
    if (!doc || typeof doc !== 'object' || doc.__unreadable) {
      console.warn(`⚠️ migration 036: ${sourcePath} unreadable — skipping. Resolve manually before next boot.`);
      return { ok: false, reason: 'unreadable' };
    }

    const series = Array.isArray(doc.series) ? doc.series : [];
    const existingIds = await existingRecordIds(typeDir);
    await mkdir(typeDir, { recursive: true });

    let written = 0;
    let skipped = 0;
    let invalid = 0;
    for (const record of series) {
      if (!record || typeof record !== 'object' || typeof record.id !== 'string' || !VALID_ID.test(record.id)) {
        invalid += 1;
        console.warn(`⚠️ migration 036: skipping series with invalid id "${record?.id ?? null}"`);
        continue;
      }
      if (existingIds.has(record.id)) {
        skipped += 1;
        continue;
      }
      await mkdir(join(typeDir, record.id), { recursive: true });
      await writeJson(join(typeDir, record.id, 'index.json'), record);
      written += 1;
    }

    await writeJson(typeIndexPath, {
      schemaVersion: TYPE_SCHEMA_VERSION,
      type: TYPE_LABEL,
      updatedAt: new Date().toISOString(),
      config: {},
    });

    if (legacyExists) await rename(legacyPath, backupPath);

    console.log(
      `📦 migration 036: split ${written} series record(s) into data/${TYPE_DIR_NAME}/<id>/index.json ` +
      `(${skipped} already split, ${invalid} invalid); legacy file backed up as ${LEGACY_FILENAME}${BACKUP_SUFFIX}`,
    );
    return { ok: true, reason: 'split', written, skipped, invalid };
  },
};
