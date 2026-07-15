// Pure resolver for CyberCity's URL-addressed building focus (issue #2593). Maps the
// `/city/apps/:appId` route param + the live app list into a concrete render state.
//
// The key subtlety: a valid deep link whose app list is still loading must NOT flash the
// "building not found" fallback. So `notFound` is only true once the list has finished loading
// AND the id still matches nothing (deleted/archived-away/never-existed id).

export function resolveCityFocus(appId, apps, { loading = false } = {}) {
  const hasFocus = typeof appId === 'string' && appId.length > 0;
  if (!hasFocus) return { hasFocus: false, focusedApp: null, notFound: false };

  const list = Array.isArray(apps) ? apps : [];
  const focusedApp = list.find((a) => a?.id === appId) || null;
  // Still loading → keep waiting (a valid id may resolve once apps arrive). Loaded + missing → 404.
  const notFound = !focusedApp && !loading;

  return { hasFocus: true, focusedApp, notFound };
}
