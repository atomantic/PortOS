// The Importer deep-link contract, both directions:
//   - `buildImporterLink` produces the `/importer?…` URL a Series Pipeline page
//     navigates to so the importer opens pre-targeted at a universe/series.
//   - `resolveImporterDeepLink` reads those params back into the universe +
//     series NAMES the importer matches on (it matches by name, not id).
// Keeping both in one module means a param-name change touches a single file.

// Build an `/importer` deep-link. An existing universe/series is referenced by
// id; a not-yet-created series (e.g. a typed-but-unsaved name on the create
// form) is passed by name. All parts are optional — with none, this is just
// `/importer`.
export function buildImporterLink({ universeId, seriesId, seriesName } = {}) {
  const params = new URLSearchParams();
  if (universeId) params.set('universeId', universeId);
  if (seriesId) params.set('seriesId', seriesId);
  if (seriesName && seriesName.trim()) params.set('series', seriesName.trim());
  const qs = params.toString();
  return qs ? `/importer?${qs}` : '/importer';
}

// Resolve a deep-link into the universe + series names the Importer matches on.
// A Series Pipeline page links here with `?universeId=…&seriesId=…`; raw
// `universe`/`series` name params are accepted as a fallback (e.g. an
// in-progress create form that has a typed name but no id yet). Ids win over
// names: a `seriesId` also pins its parent universe so the pair can't drift.
// Returns the resolved names (each '' when nothing matched) — the caller only
// overwrites intake fields that resolved to a non-empty value.
export function resolveImporterDeepLink({
  universeId, seriesId, universeName, seriesName, universes = [], series = [],
}) {
  let uName = '';
  let sName = '';
  if (seriesId) {
    const s = series.find((x) => x.id === seriesId);
    if (s) {
      sName = s.name || '';
      const u = universes.find((x) => x.id === s.universeId);
      if (u) uName = u.name || '';
    }
  }
  if (!uName && universeId) {
    const u = universes.find((x) => x.id === universeId);
    if (u) uName = u.name || '';
  }
  if (!uName && universeName) uName = universeName;
  if (!sName && seriesName) sName = seriesName;
  return { universeName: uName, seriesName: sName };
}
