// Fuzzy match a spoken/typed phrase ("BookLoom", "book loom", "the bookloom
// app") to a managed app from `getActiveApps()`. Pure helper — caller fetches
// the apps list.
//
// Tiered match strategy mirrors `navManifest.resolveNavCommand`: exact →
// prefix → substring, biased to the longest candidate name on substring ties
// so "book loom" picks "BookLoom" over a stray "Book" app.
//
// Returns the matched app object (with `id`) or `null` when no candidate is
// close enough. Caller decides the not-found UX.

const normalize = (s) => (typeof s === 'string' ? s : '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '');

export function resolveAppByPhrase(phrase, apps) {
  const target = normalize(phrase);
  if (target.length < 2) return null;
  if (!Array.isArray(apps) || apps.length === 0) return null;

  const entries = apps
    .map((app) => ({ app, name: normalize(app?.name), id: normalize(app?.id) }))
    .filter((e) => e.name || e.id);
  if (entries.length === 0) return null;

  const pickLongest = (hits) => hits.reduce((a, b) => (b.name.length >= a.name.length ? b : a)).app;

  // Tier 1: exact id or normalized-name match.
  for (const e of entries) {
    if (e.name === target || e.id === target) return e.app;
  }
  // Tier 2: prefix overlap in either direction. Min 3 chars on the candidate
  // so a 2-letter id (e.g. "ai") doesn't greedily prefix-match every utterance.
  const prefixHits = entries.filter((e) =>
    (e.name.length >= 3 && (e.name.startsWith(target) || target.startsWith(e.name)))
    || (e.id.length >= 3 && (e.id.startsWith(target) || target.startsWith(e.id))));
  if (prefixHits.length) return pickLongest(prefixHits);

  // Tier 3: substring containment in either direction, min 3 chars on both
  // sides so "ax" doesn't match every app whose name contains "ax".
  if (target.length >= 3) {
    const substringHits = entries.filter((e) =>
      (e.name.length >= 3 && (e.name.includes(target) || target.includes(e.name)))
      || (e.id.length >= 3 && (e.id.includes(target) || target.includes(e.id))));
    if (substringHits.length) return pickLongest(substringHits);
  }
  return null;
}
