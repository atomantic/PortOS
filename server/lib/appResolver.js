// Sibling of `navManifest.resolveNavCommand` but for managed apps (free-form
// `{ id, name }` records, not a static alias table). Tier ordering matters:
// an exact match must beat a prefix/substring overlap even when a later
// entry would also qualify on the looser tier, so the tiers run as ordered
// passes rather than one short-circuit loop. Longest-name tiebreak biases
// "book loom" to "BookLoom" over a stray "Book" app.

const normalizeForMatch = (s) => (typeof s === 'string' ? s : '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '');

// Per-tier predicates. The 3-char floor on candidate name/id keeps a 2-char id
// (e.g. "ai") from greedily matching every phrase under prefix/substring; the
// `minTarget` floor on the substring tier blocks short targets from finding
// long candidates by inclusion. Tier 1 carries neither floor — an exact hit
// is unambiguous regardless of length.
const TIERS = [
  { test: (e, t) => e.name === t || e.id === t },
  { test: (e, t) =>
    (e.name.length >= 3 && (e.name.startsWith(t) || t.startsWith(e.name)))
    || (e.id.length >= 3 && (e.id.startsWith(t) || t.startsWith(e.id))) },
  { minTarget: 3, test: (e, t) =>
    (e.name.length >= 3 && (e.name.includes(t) || t.includes(e.name)))
    || (e.id.length >= 3 && (e.id.includes(t) || t.includes(e.id))) },
];

const pickLongest = (hits) => hits.reduce((a, b) => (b.name.length >= a.name.length ? b : a)).app;

export function resolveAppByPhrase(phrase, apps) {
  const target = normalizeForMatch(phrase);
  if (target.length < 2) return null;
  if (!Array.isArray(apps) || apps.length === 0) return null;

  const entries = apps
    .map((app) => ({ app, name: normalizeForMatch(app?.name), id: normalizeForMatch(app?.id) }))
    .filter((e) => e.name || e.id);
  if (entries.length === 0) return null;

  for (const { minTarget = 0, test } of TIERS) {
    if (target.length < minTarget) continue;
    const hits = entries.filter((e) => test(e, target));
    if (hits.length) return pickLongest(hits);
  }
  return null;
}
