/**
 * Re-bind every Eidoverse foundation to evidence about its OWN body (#7625).
 *
 * Until now the agent-free resilience assay replayed whatever module the author
 * named in `contributionId` — free text on the authoring surface — so a
 * foundation could promote to `baseline`, and be offered to every federated
 * peer, on a passing verdict that described a shipped demo fixture rather than
 * the body inside the envelope. The gate now derives the sandbox from `body`
 * (`server/lib/eidoverseFoundationSandbox.js`), which makes every verdict
 * recorded before this release evidence about the wrong object.
 *
 * So each record is rewritten the same way the ledger already rewrites one that
 * is re-authored, and for the identical reason — the verdict no longer
 * describes the body:
 *
 *   - `contributionId` is replaced with the label the record's own kind/body
 *     derives, so the binding check reads true for the right reason.
 *   - a record whose body has no derivable sandbox drops `assay` and
 *     `candidate` and, if it was `baseline` and locally authored, returns to
 *     `vernacular` with `promotedAt: null`. It is local work again until
 *     somebody re-authors a replayable body and promotes it.
 *   - a record that IS derivable still drops `assay`/`candidate`, because the
 *     stored verdict was produced by the old replay. Re-running the assay is a
 *     click (or one `eidoverse.promote` call) and is the honest way to get the
 *     new one; synthesizing a pass here would repeat the exact mistake.
 *   - an INHERITED copy (`peer:<origin>:<id>`) is left alone but de-promoted in
 *     the same sense: its candidate is a pre-v3 envelope this install would now
 *     refuse, so it is dropped and the copy stops being offered or trusted.
 *
 * `data/eidoverse/foundations.json` is machine-local and ships NO
 * `data.reference/` seed (see `scripts/lib/migrationOwnedPaths.js`), so this
 * gates on the INPUT's presence — an install that never authored a foundation
 * has nothing to migrate and writes nothing.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { derivedContributionId } from '../../server/lib/eidoverseFoundations.js';
import { foundationSandbox } from '../../server/lib/eidoverseFoundationSandbox.js';
import { findControllerDefinitionById } from '../../server/services/eidoverseControllerRegistry.js';

export default {
  async up({ rootDir }) {
    const file = join(rootDir, 'data', 'eidoverse', 'foundations.json');
    const raw = await readFile(file, 'utf-8').catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (raw === null) return { updated: 0, reason: 'no-foundation-ledger' };

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      // A ledger this process cannot parse must not be replaced with an empty
      // one — the same rule `readFoundations()` enforces at runtime.
      console.warn(`⚠️ migration 397: data/eidoverse/foundations.json is unreadable (${error.message}); leaving it untouched`);
      return { updated: 0, reason: 'unreadable-ledger' };
    }
    const foundations = parsed?.foundations;
    if (!foundations || typeof foundations !== 'object') return { updated: 0, reason: 'no-foundation-ledger' };

    let rewritten = 0;
    let dePromoted = 0;
    for (const [key, record] of Object.entries(foundations)) {
      if (!record || typeof record !== 'object') continue;
      const hadEvidence = Boolean(record.assay || record.candidate);
      const next = { ...record, assay: null, candidate: null };

      if (record.inheritance) {
        // An inherited copy keeps the origin's label: this install never
        // replayed it and must not start now (replaying a peer's body is what
        // the assay harness exists to keep off every other install).
        if (hadEvidence) { foundations[key] = next; rewritten += 1; }
        continue;
      }

      next.contributionId = derivedContributionId({ kind: record.kind, id: record.id, body: record.body });
      const { refusal } = await foundationSandbox(record, { findControllerDefinition: findControllerDefinitionById });
      if (refusal && record.layer === 'baseline') {
        next.layer = 'vernacular';
        next.promotedAt = null;
        dePromoted += 1;
      }
      if (hadEvidence || next.contributionId !== record.contributionId || next.layer !== record.layer) {
        foundations[key] = next;
        rewritten += 1;
      }
    }

    if (rewritten === 0) return { updated: 0, reason: 'already-derived' };
    await writeFile(file, `${JSON.stringify({ ...parsed, foundations }, null, 2)}\n`);
    console.log(`🔁 migration 397: re-bound ${rewritten} Eidoverse foundation(s) to body-derived assay evidence (${dePromoted} returned to vernacular)`);
    return { updated: rewritten, dePromoted };
  },
};
