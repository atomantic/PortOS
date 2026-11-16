/**
  * Generic taxonomy tally + top-N-line renderer (#2800).
  *
  * the engine shared by the Layered Intelligence leaf modules `services/layeredIntelligenceRejections.js` (proposal-REJECTION taxonomy, #2689) and `services/layeredIntelligenceExecutionFailures.js` (execution-FAILURE taxonomy, #2764 §1), which carried near-verbatim copies that would drift: a Map-counting `summarize*` (commonest-first, taxonomy-order tie-break) over the three-bucket `{entries, unknown, unclassified, diagnosed, total}` discipline, a `format*` top-N renderer, and a private `normalizeToken`. Each taxonomy keeps only its vocabulary, gloss map and classifier. A LEAF by design (imports nothing from the LI graph, so neither taxonomy cross-imports the other). Pure, no I/O, no LLM call.
 */

/** Normalize a raw token (tracker label, stateReason, error category): lowercased with separators collapsed so `not_planned` / `not-planned` / `Not Planned` share a key; a non-string yields '' (never matches). */
export function normalizeToken(value) {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/[\s_-]+/g, '-') : '';
}

/** Render one taxonomy token as prose via a gloss map. An unglossed token passes through; a nullish (unclassified) input renders '' (mapping it onto a sentinel would dress "not classified" up as "classified, and we found nothing"). */
export function formatTaxonomyToken(token, labels) {
  if (!token) return '';
  return labels[token] || token;
}

/**
 * Tally a taxonomy across a record set with the three-bucket discipline the two LI taxonomies share. Config: `predicate(record)` (is it part of the diagnosed population; failing and nullish records are skipped),
 * `select(record)` (the stored classification token), `vocabulary` (REAL-diagnosis tokens; its order is the tie-break order), `sentinel` ("looked and found nothing", counted as `unknown`, a MEASURED gap, never a finding),
 * `field` (the key each entry carries the token under: `reason` / `category`).
 * Returns `{ entries, unknown, unclassified, diagnosed, total }`: `entries` is `[{ [field], count }]` of REAL diagnoses only, commonest first, ties by `vocabulary` order (stable regardless of record order);
 * `unknown` counts sentinel records; `unclassified` counts records whose token is absent or not in `vocabulary` (pre-field, or a newer version's token): an UNMEASURED gap; `diagnosed` sums `entries`; `total = diagnosed + unknown + unclassified`.
 * Both gaps stay OUT of `entries` so they can't crowd real diagnoses out of a top-N list. Internal stage of `createTaxonomyTally`, unexported so the pipeline can evolve without a barrel-visible change.
 */
function tallyTaxonomy(records, { predicate, select, vocabulary, sentinel, field }) {
  const counts = new Map();
  let unknown = 0;
  let unclassified = 0;
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || !predicate(record)) continue;
    const token = select(record);
    if (token === sentinel) { unknown += 1; continue; }
    // Absent OR unrecognized: no valid diagnosis for a record that belongs to the population.
    if (!vocabulary.includes(token)) { unclassified += 1; continue; }
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  const entries = [...counts.entries()]
    // Commonest first; ties by taxonomy order so output doesn't depend on Map insertion (record order).
    .sort((a, b) => b[1] - a[1] || vocabulary.indexOf(a[0]) - vocabulary.indexOf(b[0]))
    .map(([token, count]) => ({ [field]: token, count }));
  const diagnosed = entries.reduce((n, e) => n + e.count, 0);
  return { entries, unknown, unclassified, diagnosed, total: diagnosed + unknown + unclassified };
}

/**
 * Render a tally (from `tallyTaxonomy`) as one prompt line: the commonest `limit` diagnoses, glossed, then any non-zero gaps. Returns '' ONLY when the population is empty (`total === 0`), so '' safely reads "nothing to explain";
 * it must never fall silent merely because the population is undiagnosed (a report naming a non-zero count then staying quiet about why is the blindness these taxonomies remove).
 * Config: `field` (must match `tallyTaxonomy`'s), `glossFn(token)`, `gapWording` (`{ unknown(n, total), unclassified(n, total) }` returning each gap clause; the taxonomies phrase `unknown` differently).
 * Internal stage of `createTaxonomyTally`, unexported.
 */
function renderTallyLine(summary, { field, glossFn, limit = 3, gapWording }) {
  const { entries, unknown, unclassified, total } = summary;
  if (total === 0) return '';
  const listed = entries
    .slice(0, limit)
    .map((entry) => `${glossFn(entry[field])} (${entry.count})`)
    .join('; ');
  // Name every non-zero gap: an undiagnosed share is an actionable fact about the loop's blind spot.
  const gaps = [
    unknown ? gapWording.unknown(unknown, total) : '',
    unclassified ? gapWording.unclassified(unclassified, total) : ''
  ];
  return [listed, ...gaps].filter(Boolean).join(' — ');
}

/** Bind a full taxonomy config into the `{ summarize, format }` pair each taxonomy module re-exports: `summarize(records)` returns the three-bucket tally, `format(records, limit)` the top-N line. Config is the union of `tallyTaxonomy`'s and `renderTallyLine`'s: `{ predicate, select, field, vocabulary, sentinel, glossFn, gapWording }`. */
export function createTaxonomyTally({ predicate, select, field, vocabulary, sentinel, glossFn, gapWording }) {
  const summarize = (records = []) => tallyTaxonomy(records, { predicate, select, vocabulary, sentinel, field });
  const format = (records = [], limit = 3) => renderTallyLine(summarize(records), { field, glossFn, limit, gapWording });
  return { summarize, format };
}
