/**
 * Repair MortalLoom-import health files that were written as bare arrays.
 *
 * Earlier `importToPortOS` builds created a missing destination as a bare JSON
 * array. The local readers (`meatspaceHealth.js`) expect object wrappers, so
 * such a file parsed fine yet read as zero records:
 *
 *   blood-tests.json       -> { tests: [...], referenceRanges: {} }
 *   epigenetic-tests.json  -> { tests: [...] }
 *   eyes.json              -> { exams: [...] }
 *   health-metrics.json    -> { entries: [...] }
 *
 * Blood rows from that import also kept MortalLoom's nested `markers`; the
 * local reader consumes flat marker fields, so each is flattened (row `id`,
 * `date` and every other field are kept).
 *
 * Safety contract:
 *   - Only a file whose whole content is a JSON array of plain objects is
 *     touched. Wrappers, absent files and any other shape are left byte-for-byte.
 *   - Invalid JSON, a non-object row, or ambiguous blood `markers` (not an
 *     object, or one that collides with a row field) refuses that file and
 *     logs; nothing is replaced with defaults.
 *   - The original bytes are copied to `<file>.pre-438.json` before the
 *     wrapper replaces the file (atomic rename). An existing backup is kept
 *     only when it is byte-identical to the current file; otherwise the file
 *     is refused rather than losing either copy.
 *   - An unreadable file (EACCES, EISDIR, ...) fails the migration after the
 *     other files are handled, so it is retried rather than marked applied.
 *   - Idempotent and interruption-safe: a repaired file is a wrapper (skipped);
 *     a crash after the backup leaves the array in place for the next run.
 *
 * This is a frozen transform: it does not import the live services. The repair
 * is derived from the install's own rows, so it ships no `data.reference` seed.
 */
import { readFile } from 'fs/promises';
import { join } from 'path';
import { writeJsonAtomic, writeTextAtomic } from './_lib.js';

const TARGETS = [
  { file: 'blood-tests.json', key: 'tests', extra: () => ({ referenceRanges: {} }), flattenMarkers: true },
  { file: 'epigenetic-tests.json', key: 'tests', extra: () => ({}) },
  { file: 'eyes.json', key: 'exams', extra: () => ({}) },
  { file: 'health-metrics.json', key: 'entries', extra: () => ({}) },
];

const BACKUP_SUFFIX = '.pre-438.json';
// A marker named like a row field would silently overwrite or be overwritten;
// the reserved names are refused even when this particular row lacks them.
const RESERVED_ROW_KEYS = ['id', 'date', 'createdAt', 'updatedAt', 'aliasIds', 'markers'];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Flat blood row, or null when `markers` is ambiguous. */
function flattenBloodRow(row) {
  if (!Object.hasOwn(row, 'markers') || row.markers == null) {
    const { markers: _drop, ...rest } = row;
    return rest;
  }
  const { markers, ...rest } = row;
  if (!isObject(markers) || RESERVED_ROW_KEYS.some((key) => Object.hasOwn(markers, key))
    || Object.keys(markers).some((key) => Object.hasOwn(rest, key))) return null;
  return { ...markers, ...rest };
}

async function readBytes(path) {
  try { return await readFile(path); } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function repairFile(dir, { file, key, extra, flattenMarkers }) {
  const path = join(dir, file);
  const bytes = await readBytes(path);
  if (bytes === null) return;

  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf-8')); } catch {
    console.log(`⏭️ ${file}: not valid JSON; left untouched`);
    return;
  }
  if (!Array.isArray(parsed)) return;

  if (!parsed.every(isObject)) {
    console.log(`⏭️ ${file}: array holds non-object rows; left untouched`);
    return;
  }
  const rows = flattenMarkers ? parsed.map(flattenBloodRow) : parsed;
  if (rows.includes(null)) {
    console.log(`⏭️ ${file}: ambiguous blood markers; left untouched`);
    return;
  }

  const backupPath = `${path}${BACKUP_SUFFIX}`;
  const existingBackup = await readBytes(backupPath);
  if (existingBackup === null) {
    await writeTextAtomic(backupPath, bytes); // temp + rename: a torn backup would wedge every retry
  } else if (!existingBackup.equals(bytes)) {
    console.log(`⏭️ ${file}: a different ${file}${BACKUP_SUFFIX} already exists; left untouched`);
    return;
  }

  await writeJsonAtomic(path, { [key]: rows, ...extra() });
  console.log(`📝 ${file}: wrapped ${rows.length} legacy array row(s) as { ${key} } (original kept as ${file}${BACKUP_SUFFIX})`);
}

export default {
  async up({ rootDir }) {
    const dir = join(rootDir, 'data', 'meatspace');
    const failures = [];
    for (const target of TARGETS) {
      try { await repairFile(dir, target); } catch (err) {
        failures.push(`${target.file}: ${err.message}`);
      }
    }
    if (failures.length) {
      throw new Error(`Legacy health array repair incomplete (will retry): ${failures.join('; ')}`);
    }
  },
};
