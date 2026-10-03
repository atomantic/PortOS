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
 *
 * Conversion writes the merged JSONL (existing lines first, then new legacy
 * entries) to an exclusive temporary sibling, then renames it over
 * `history.jsonl` before the legacy file is renamed aside. A destination I/O
 * failure (open/write/finish) aborts: the temp file is removed, both original
 * files stay byte-identical, and `up()` rejects so the runner leaves the
 * migration pending for a retry after repair (#9784).
 */

import { createReadStream, createWriteStream } from 'fs';
import { mkdir, rename, rm, stat } from 'fs/promises';
import { finished } from 'stream/promises';
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
            let entry;
            let parsed = false;
            try {
              entry = JSON.parse(buf);
              parsed = true;
            } catch {
              invalid += 1;
            }
            inObject = false;
            buf = '';
            // Outside the parse try: an onEntry (destination) failure is an
            // operational error that aborts the stream, never a malformed entry.
            if (parsed) await onEntry(entry);
          }
        }
        stream.resume();
      } catch (err) {
        stream.destroy();
        reject(err);
      }
    });
    stream.on('close', () => { if (done) finish(); });
  });
}

/**
 * Exclusive-create write stream whose `error` event is owned from the start,
 * so an open/write failure surfaces as a rejected promise instead of an
 * unhandled EventEmitter error that kills the process.
 */
function openExclusiveSink(path) {
  const out = createWriteStream(path, { flags: 'wx' });
  let streamError = null;
  let created = false;
  out.on('error', (err) => { streamError ??= err; });
  out.once('open', () => { created = true; });

  const write = (chunk) => new Promise((resolve, reject) => {
    if (streamError) return reject(streamError);
    out.write(chunk, (err) => (err ? reject(err) : resolve()));
  });
  const close = async () => {
    if (streamError) throw streamError;
    out.end();
    await finished(out);
  };
  // Wait for the fd to close so a later rm() cannot race a still-pending open.
  const abort = () => new Promise((resolve) => {
    if (out.closed) return resolve();
    out.once('close', resolve);
    out.destroy();
  });
  return { write, close, abort, wasCreated: () => created };
}

async function copyExistingJsonl(jsonlPath, sink) {
  let last = null;
  for await (const chunk of createReadStream(jsonlPath)) {
    if (!chunk.length) continue;
    await sink.write(chunk);
    last = chunk[chunk.length - 1];
  }
  // A final line without its newline would otherwise fuse with the first
  // converted entry.
  if (last !== null && last !== 0x0a) await sink.write('\n');
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
    const tmpPath = `${jsonlPath}.tmp-037-${process.pid}-${Date.now()}`;
    const sink = openExclusiveSink(tmpPath);
    let skippedDuplicate = 0;
    let converted = 0;
    let skippedInvalid;
    let destinationError = null;
    const discardTemp = async () => {
      await sink.abort();
      // Only remove a temp file this run created — never a pre-existing one
      // that made the exclusive open fail.
      if (sink.wasCreated()) await rm(tmpPath, { force: true });
    };
    try {
      if (jsonlExists) await copyExistingJsonl(jsonlPath, sink);
      const parsed = await streamLegacyEntries(legacyPath, async (entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          return;
        }
        if (typeof entry.id === 'string' && existingIds.has(entry.id)) {
          skippedDuplicate += 1;
          return;
        }
        try {
          await sink.write(`${JSON.stringify(entry)}\n`);
        } catch (err) {
          destinationError = err;
          throw err;
        }
        converted += 1;
        if (typeof entry.id === 'string') existingIds.add(entry.id);
      }).catch((err) => {
        if (destinationError) throw destinationError;
        console.warn(`⚠️ migration 037: ${legacyPath} unreadable or not { entries: [...] } — skipping. Resolve manually before next boot.`);
        return null;
      });
      if (parsed === null) {
        await discardTemp();
        return { ok: false, reason: 'unreadable' };
      }
      skippedInvalid = parsed.skippedInvalid;
      await sink.close();
      await rename(tmpPath, jsonlPath);
    } catch (err) {
      await discardTemp();
      console.error(`❌ migration 037: writing data/${JSONL_FILENAME} failed (${err.code ?? err.message}) — legacy history left in place; migration stays pending`);
      throw err;
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
