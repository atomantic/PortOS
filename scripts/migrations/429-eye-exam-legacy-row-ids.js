/** Re-key legacy eye exams to content-derived ids and collapse their duplicates
 * (#12432). Before this, each machine stamped an id-less eyes.json row with its
 * own `randomUUID()`, so syncing peers appended each other's copy of the same
 * exam. Every row without `createdAt` predates minted ids, so its random stamp
 * is replaced by the `legacy-` id every peer derives from the row's content, and
 * rows that land on the same id are one exam. Rows created since keep their id.
 * Input-gated on eyes.json; ships no seed. Idempotent: re-keyed rows keep their id. */
import { join } from 'node:path';
import { readJsonOrNull, writeJsonAtomic } from './_lib.js';
import { normalizeLegacyRows } from '../../server/lib/meatspaceRowIdentity.js';

export default {
  async up({ rootDir }) {
    const path = join(rootDir, 'data', 'meatspace', 'eyes.json');
    const doc = await readJsonOrNull(path);
    if (!doc || !Array.isArray(doc.exams)) return { rekeyed: 0, collapsed: 0 };
    const { rows, changed } = normalizeLegacyRows(doc.exams);
    if (!changed) return { rekeyed: 0, collapsed: 0 };
    const kept = new Set(doc.exams);
    const rekeyed = rows.filter((row) => !kept.has(row)).length;
    rows.sort((a, b) => (a?.date || '').localeCompare(b?.date || ''));
    await writeJsonAtomic(path, { ...doc, exams: rows });
    return { rekeyed, collapsed: doc.exams.length - rows.length };
  }
};
