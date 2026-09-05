/**
 * Readers for the managed-app repository-source payload that
 * `GET /api/apps/:id/repository-sources` returns
 * (`server/services/managedAppRepositories.js`).
 *
 * The fork rule is a correctness rule rather than a formatting one — a
 * DIVERGED fork can never be fast-forwarded, so an update must not ask the
 * server to sync it — and two surfaces now read it: the app's Git tab and the
 * Eidoverse page's out-of-date advisory. One definition, so they cannot drift.
 */

/** The application checkout itself, as opposed to its companion checkouts. */
export const primaryRepositorySource = (sources = []) =>
  sources.find((source) => source.id === 'primary') || sources[0] || null;

export const repositoryForkDiverged = (source) => source?.forkVsUpstream?.state === 'diverged';

/** Can this checkout's origin fork be fast-forwarded from canonical upstream? */
export const repositoryForkNeedsSync = (source) => Boolean(source?.origin?.isFork)
  && (source?.forkVsUpstream?.behind || 0) > 0
  && !repositoryForkDiverged(source);

/** `countText(2, 'commit')` → "2 commits". One phrasing for both update surfaces. */
export const countText = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * One human clause per checkout that is behind something an update would pull
 * it forward from. Empty when the whole source stack is current.
 */
export function describeRepositorySourcesBehind(sources = []) {
  const clauses = [];
  for (const source of sources) {
    const label = source?.label || 'checkout';
    const localBehind = source?.localVsOrigin?.behind || 0;
    const forkBehind = source?.forkVsUpstream?.behind || 0;
    if (localBehind > 0) clauses.push(`${label} is ${countText(localBehind, 'commit')} behind its origin`);
    if (forkBehind > 0) clauses.push(`the ${label} fork is ${countText(forkBehind, 'commit')} behind upstream`);
  }
  return clauses;
}
