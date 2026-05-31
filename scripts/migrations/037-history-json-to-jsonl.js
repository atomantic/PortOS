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

import { createReadStream, createWriteStream } from 'fs';
import { mkdir, rename, rm, stat } from 'fs/promises';
import { createInterface } from 'readline';
import { join, relative } from 'path';
import { writeJSONLines } from '../../server/lib/fileUtils.js';

const LEGACY_FILENAME = 'history.json';
const JSONL_FILENAME = 'history.jsonl';
const BACKUP_SUFFIX = '.bak-037';

const fileExists = (path) => stat(path).then(() => true, (err) => {
  if (err.code === 'ENOENT') return false;
  throw err;
});

async function readExistingIds(jsonlPath) {
  if (!await fileExists(jsonlPath)) return new Set();
  const ids = new Set();
  const rl = createInterface({ input: createReadStream(jsonlPath, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry.id === 'string') ids.add(entry.id);
    } catch { /* malformed legacy line: keep it in place, just cannot dedupe by id */ }
  }
  return ids;
}

async function streamLegacyEntries(legacyPath, onEntry) {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(legacyPath, { encoding: 'utf8' });
    let beforeArray = '';
    let inArray = false;
    let inObject = false;
    let inString = false;
    let escaped = false;
    let depth = 0;
    let buf = '';
    let skippingPrimitive = false;
    let sawEntries = false;
    let done = false;
    let invalid = 0;

    const finish = () => {
      if (!sawEntries) reject(new Error('missing entries array'));
      else resolve({ skippedInvalid: invalid });
    };

    stream.on('error', reject);
    stream.on('end', finish);
    stream.on('data', async (chunk) => {
      stream.pause();
      try {
        let i = 0;
        if (!inArray) {
          beforeArray += chunk;
          const key = beforeArray.indexOf('"entries"');
          const bracket = key === -1 ? -1 : beforeArray.indexOf('[', key);
          if (bracket === -1) {
            beforeArray = beforeArray.slice(-32);
            stream.resume();
            return;
          }
          sawEntries = true;
          inArray = true;
          chunk = beforeArray.slice(bracket + 1);
          beforeArray = '';
        }

        for (; i < chunk.length && !done; i++) {
          const ch = chunk[i];
          if (!inObject) {
            if (skippingPrimitive) {
              if (ch === ',') skippingPrimitive = false;
              else if (ch === ']') { done = true; stream.destroy(); break; }
              continue;
            }
            if (ch === ']') { done = true; stream.destroy(); break; }
            if (ch === '{') {
              inObject = true;
              inString = false;
              escaped = false;
              depth = 1;
              buf = '{';
            } else if (!/\s|,/.test(ch)) {
              invalid += 1;
              skippingPrimitive = true;
            }
            continue;
          }

          buf += ch;
          if (escaped) { escaped = false; continue; }
          if (ch === '\\') { escaped = true; continue; }
          if (ch === '"') { inString = !inString; continue; }
          if (inString) continue;
          if (ch === '{') depth += 1;
          else if (ch === '}') depth -= 1;

          if (depth === 0) {
            try {
              await onEntry(JSON.parse(buf));
            } catch {
              invalid += 1;
            }
            inObject = false;
            buf = '';
          }
        }
        stream.resume();
      } catch (err) {
        reject(err);
      }
    });
    stream.on('close', () => { if (done) finish(); });
  });
}

function writeJsonlLine(out, entry) {
  const line = `${JSON.stringify(entry)}\n`;
  return new Promise((resolve, reject) => {
    out.write(line, (err) => err ? reject(err) : resolve());
  });
}

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

    const existingIds = await readExistingIds(jsonlPath);
    if (!jsonlExists) await writeJSONLines(jsonlPath, []);

    const out = createWriteStream(jsonlPath, { flags: 'a' });
    let skippedDuplicate = 0;
    let converted = 0;
    const { skippedInvalid } = await streamLegacyEntries(legacyPath, async (entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return;
      }
      if (typeof entry.id === 'string' && existingIds.has(entry.id)) {
        skippedDuplicate += 1;
        return;
      }
      await writeJsonlLine(out, entry);
      converted += 1;
      if (typeof entry.id === 'string') existingIds.add(entry.id);
    }).catch((err) => {
      out.end();
      console.warn(`⚠️ migration 037: ${legacyPath} unreadable or not { entries: [...] } — skipping. Resolve manually before next boot.`);
      return { __error: err };
    });
    await new Promise((resolve, reject) => out.end((err) => err ? reject(err) : resolve()));
    if (skippedInvalid == null) {
      if (!jsonlExists) await rm(jsonlPath, { force: true });
      return { ok: false, reason: 'unreadable' };
    }

    const finalBackupPath = await fileExists(backupPath)
      ? `${backupPath}-${Date.now()}`
      : backupPath;
    await rename(legacyPath, finalBackupPath);

    console.log(
      `📦 migration 037: converted ${converted} history entr${converted === 1 ? 'y' : 'ies'} ` +
      `to data/${JSONL_FILENAME} (${skippedDuplicate} duplicate, ${skippedInvalid} invalid); ` +
      `legacy file backed up as ${relative(dataDir, finalBackupPath)}`,
    );

    return {
      ok: true,
      reason: 'converted',
      converted,
      skippedDuplicate,
      skippedInvalid,
    };
  },
};
