/**
 * Mirror of server/lib/seasonStructure.js — kept here so the client-side
 * issue-count hint can render without round-tripping through the API.
 *
 * 6–10 issues per volume/season is the comic-as-TV sweet spot. Single volume
 * up to 12; 3-volume arc lands roughly at 18–30. The "3 × 8 = 24" point is
 * the canonical "3-season arc" target.
 *
 * Keep this in sync with the server file — there's no shared bundle, but
 * the function bodies are tiny and tested on the server side.
 */

function pickSeasonCount(total) {
  if (total <= 12) return 1;
  if (total <= 17) return 2;
  if (total <= 32) return 3;
  if (total <= 44) return 4;
  return 5;
}

export function recommendStructure(total) {
  const n = Math.floor(Number(total) || 0);
  if (n <= 0) return null;
  const seasons = pickSeasonCount(n);
  const base = Math.floor(n / seasons);
  const remainder = n % seasons;
  const perSeason = Array.from(
    { length: seasons },
    (_, i) => base + (i < remainder ? 1 : 0),
  );
  return { seasons, perSeason };
}

export function describeStructure(structure) {
  if (!structure) return '';
  const { seasons, perSeason } = structure;
  const allSame = perSeason.every((n) => n === perSeason[0]);
  if (allSame) {
    return seasons === 1
      ? `1 volume × ${perSeason[0]} episodes`
      : `${seasons} volumes × ${perSeason[0]} episodes`;
  }
  return `${seasons} volumes × ~${Math.round(perSeason.reduce((a, b) => a + b, 0) / seasons)} (${perSeason.join(', ')})`;
}
