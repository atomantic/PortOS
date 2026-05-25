/**
 * Convert action history from the legacy monolithic JSON wrapper:
 *
 *   data/history.json       { "entries": [...] }
 *
 * to append-friendly JSON Lines:
 *
 *   data/history.jsonl      one history entry per line
 *
 * The live service appends to `history.jsonl`, so routine action logging no
 * longer rewrites the full history file. The legacy file is renamed to
 * `history.json.bak-037` after conversion for manual recovery.
 */

import { mkdir, readFile, rename, stat } from 'fs/promises';
import { join, relative } from 'path';
import { readJSONLFile, writeJSONLines } from '../../server/lib/fileUtils.js';

const LEGACY_FILENAME = 'history.json';
const JSONL_FILENAME = 'history.jsonl';
const BACKUP_SUFFIX = '.bak-037';

const fileExists = (path) => stat(path).then(() => true, (err) => {
  if (err.code === 'ENOENT') return false;
  throw err;
});

const readJsonTolerant = async (path) => {
  const raw = await readFile(path, 'utf-8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return { __unreadable: true }; }
};

export default {
  async up({ rootDir }) {
    const dataDir = join(rootDir, 'data');
    const legacyPath = join(dataDir, LEGACY_FILENAME);
    const jsonlPath = join(dataDir, JSONL_FILENAME);
    const backupPath = legacyPath + BACKUP_SUFFIX;

    await mkdir(dataDir, { recursive: true });

    const legacyExists = await fileExists(legacyPath);
    const jsonlExists = await fileExists(jsonlPath);

    if (!legacyExists) {
      if (!jsonlExists) {
        await writeJSONLines(jsonlPath, []);
        console.log('📦 migration 037: fresh install — created empty data/history.jsonl');
        return { ok: true, reason: 'fresh-install' };
      }
      console.log('📦 migration 037: data/history.jsonl already present — no-op');
      return { ok: true, reason: 'already-jsonl' };
    }

    const legacy = await readJsonTolerant(legacyPath);
    if (!legacy || typeof legacy !== 'object' || legacy.__unreadable || !Array.isArray(legacy.entries)) {
      console.warn(`⚠️ migration 037: ${legacyPath} unreadable or not { entries: [...] } — skipping. Resolve manually before next boot.`);
      return { ok: false, reason: 'unreadable' };
    }

    const existing = await readJSONLFile(jsonlPath, { logErrors: true });
    const existingIds = new Set(existing.map((entry) => (
      entry && typeof entry.id === 'string' ? entry.id : null
    )).filter(Boolean));

    const converted = [];
    let skippedDuplicate = 0;
    let skippedInvalid = 0;
    for (const entry of legacy.entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        skippedInvalid += 1;
        continue;
      }
      if (typeof entry.id === 'string' && existingIds.has(entry.id)) {
        skippedDuplicate += 1;
        continue;
      }
      converted.push(entry);
      if (typeof entry.id === 'string') existingIds.add(entry.id);
    }

    await writeJSONLines(jsonlPath, [...existing, ...converted]);

    const finalBackupPath = await fileExists(backupPath)
      ? `${backupPath}-${Date.now()}`
      : backupPath;
    await rename(legacyPath, finalBackupPath);

    console.log(
      `📦 migration 037: converted ${converted.length} history entr${converted.length === 1 ? 'y' : 'ies'} ` +
      `to data/${JSONL_FILENAME} (${skippedDuplicate} duplicate, ${skippedInvalid} invalid); ` +
      `legacy file backed up as ${relative(dataDir, finalBackupPath)}`,
    );

    return {
      ok: true,
      reason: 'converted',
      converted: converted.length,
      skippedDuplicate,
      skippedInvalid,
    };
  },
};
