/** Collapse duplicated legacy eye exams and give id-less ones their content id
 * (#12432). Before this, each machine stamped an id-less eyes.json row with its
 * own `randomUUID()`, so syncing peers appended each other's copy of the same
 * exam. Rows without `createdAt` whose content is identical are copies of one
 * exam: they collapse to one row carrying the `legacy-` id every peer derives
 * from that content. A single row keeps its id — it may have been minted before
 * #12432 and edited — and still meets a peer's differently-stamped copy through
 * the sync merge's content key. Input-gated on eyes.json; ships no seed.
 * Idempotent: the output has no id-less rows and no duplicates left. */
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
