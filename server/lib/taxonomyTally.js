/**
 * Generic taxonomy tally + top-N-line renderer (extracted for #2800).
 *
 * Two Layered Intelligence leaf modules —
 * `services/layeredIntelligenceRejections.js` (proposal-REJECTION taxonomy, #2689)
 * and `services/layeredIntelligenceExecutionFailures.js` (execution-FAILURE
 * taxonomy, #2764 §1) — carried near-verbatim copies of the same counting +
 * rendering engine: a Map-counting `summarize*` with commonest-first sort and a
 * taxonomy-order tie-break over the three-bucket `{entries, unknown, unclassified,
 * diagnosed, total}` discipline, a `format*` top-N-line renderer, and a private
 * `normalizeToken`. The two would drift (a tie-break or gap-wording fix landing in
 * only one). This module owns that shared engine; each taxonomy module now keeps
 * only its vocabulary, gloss map, and classifier.
 *
 * A LEAF module by design: it imports nothing from the LI graph, so it does not
 * turn either taxonomy leaf into a cross-import of the other — both keep importing
 * only this small standalone helper. Pure, no I/O, no LLM call.
 */

/**
 * Normalize a raw token (a tracker label, stateReason, or error category) for
 * matching: lowercased, with separators collapsed so `not_planned`, `not-planned`,
 * `Not Planned`, and `test_failure` / `test-failure` / `Test Failure` all land on
 * the same key. A non-string yields '' (never matches a real key).
 */
export function normalizeToken(value) {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/[\s_-]+/g, '-') : '';
}

/**
 * Render one taxonomy token as prose via a gloss map. An unglossed token passes
 * through unchanged; a nullish (unclassified) input renders as '' — mapping it onto
 * a sentinel would invert the taxonomy's central rule by dressing "not classified"
 * up as "classified, and we found nothing".
 */
export function formatTaxonomyToken(token, labels) {
  if (!token) return '';
  return labels[token] || token;
}

/**
 * Tally a taxonomy across a record set, applying the three-bucket discipline the two
 * LI taxonomies share.
 *
 * Config:
 *   - `predicate(record)` — is this record part of the population being diagnosed?
 *     (a non-merged resolved proposal; a failed execution). Records that fail it, and
 *     nullish records, are skipped.
 *   - `select(record)` — reads the stored classification token off a population record.
 *   - `vocabulary` — the REAL-diagnosis tokens; its order is also the tie-break order.
 *   - `sentinel` — the "we looked and found nothing" token (counted as `unknown`, a
 *     MEASURED gap — never a finding).
 *   - `field` — the key name each entry carries the token under (`reason` / `category`).
 *
 * Returns `{ entries, unknown, unclassified, diagnosed, total }`:
 *   - `entries`      — `[{ [field], count }]` of REAL diagnoses only, commonest first,
 *                      ties broken by `vocabulary` order (stable regardless of record
 *                      ordering).
 *   - `unknown`      — records holding the sentinel: a MEASURED gap.
 *   - `unclassified` — records whose stored token is absent OR not in `vocabulary`
 *                      (pre-field, or a token from a newer version): an UNMEASURED gap.
 *   - `diagnosed`    — sum of `entries`.
 *   - `total`        — the full population (`diagnosed + unknown + unclassified`).
 *
 * `unknown`/`unclassified` stay OUT of `entries` so they can't crowd real diagnoses
 * out of a caller's top-N list — they measure missing data, they are not findings.
 *
 * Internal stage of `createTaxonomyTally` (the module's single composed seam), kept
 * unexported so the tally/render pipeline can evolve without a barrel-visible change.
 */
function tallyTaxonomy(records, { predicate, select, vocabulary, sentinel, field }) {
  const counts = new Map();
  let unknown = 0;
  let unclassified = 0;
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || !predicate(record)) continue;
    const token = select(record);
    if (token === sentinel) { unknown += 1; continue; }
    // Absent OR unrecognized: both mean we hold no valid diagnosis for a record that
    // demonstrably belongs to the population.
    if (!vocabulary.includes(token)) { unclassified += 1; continue; }
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  const entries = [...counts.entries()]
    // Commonest first; ties broken by taxonomy order so the output is stable rather
    // than dependent on Map insertion (i.e. on record ordering).
    .sort((a, b) => b[1] - a[1] || vocabulary.indexOf(a[0]) - vocabulary.indexOf(b[0]))
    .map(([token, count]) => ({ [field]: token, count }));
  const diagnosed = entries.reduce((n, e) => n + e.count, 0);
  return { entries, unknown, unclassified, diagnosed, total: diagnosed + unknown + unclassified };
}

/**
 * Render a tally (the output of `tallyTaxonomy`) as one prompt line: the commonest
 * `limit` diagnoses, glossed, followed by whichever gaps are non-zero.
 *
 * Returns '' ONLY when the population is empty (`total === 0`), so a caller may safely
 * read '' as "there is nothing to explain". It must never fall silent merely because
 * the population is undiagnosed: a report that names a non-zero count and then stays
 * quiet about why is exactly the blindness these taxonomies exist to remove.
 *
 * Config:
 *   - `field` — the entry key holding the token (must match `tallyTaxonomy`'s `field`).
 *   - `glossFn(token)` — renders a token as prose.
 *   - `gapWording` — `{ unknown(n, total), unclassified(n, total) }`, each returning the
 *     gap clause for that bucket. Both taxonomies phrase `unclassified` the same but
 *     `unknown` differently ("no recorded reason" vs "no recognized cause").
 *
 * Internal stage of `createTaxonomyTally` (the module's single composed seam), kept
 * unexported so the tally/render pipeline can evolve without a barrel-visible change.
 */
function renderTallyLine(summary, { field, glossFn, limit = 3, gapWording }) {
  const { entries, unknown, unclassified, total } = summary;
  if (total === 0) return '';
  const listed = entries
    .slice(0, limit)
    .map((entry) => `${glossFn(entry[field])} (${entry.count})`)
    .join('; ');
  // Name every non-zero gap: an undiagnosed share is a real, actionable fact about
  // the loop's own blind spot, and the honest line when it's all we have.
  const gaps = [
    unknown ? gapWording.unknown(unknown, total) : '',
    unclassified ? gapWording.unclassified(unclassified, total) : ''
  ];
  return [listed, ...gaps].filter(Boolean).join(' — ');
}

/**
 * Bind a full taxonomy config into the `{ summarize, format }` pair each taxonomy
 * module re-exports under its own domain names. `summarize(records)` returns the
 * three-bucket tally; `format(records, limit)` renders the top-N prompt line.
 *
 * Config keys are the union of `tallyTaxonomy`'s and `renderTallyLine`'s:
 * `{ predicate, select, field, vocabulary, sentinel, glossFn, gapWording }`.
 */
export function createTaxonomyTally({ predicate, select, field, vocabulary, sentinel, glossFn, gapWording }) {
  const summarize = (records = []) => tallyTaxonomy(records, { predicate, select, vocabulary, sentinel, field });
  const format = (records = [], limit = 3) => renderTallyLine(summarize(records), { field, glossFn, limit, gapWording });
  return { summarize, format };
}
