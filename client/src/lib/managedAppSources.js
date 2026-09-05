/**
 * Readers for the managed-app repository-source payload that
 * `GET /api/apps/:id/repository-sources` returns
 * (`server/services/managedAppRepositories.js`).
 *
 * Two surfaces read this payload — the app's Git tab and the Eidoverse page's
 * out-of-date advisory — and both must agree on which drift an update can
 * actually clear, because that is a correctness rule, not a formatting one:
 * asking the server to sync a fork it may not move produces a failure, and
 * announcing one as an available update produces an advisory nothing clears.
 * The server owns that rule (`isForkSyncable`) since the same rule decides
 * `updateAvailable`, and publishes it per source as `forkSyncable`; the readers
 * here phrase its answer rather than re-deriving it.
 */

/** The application checkout itself, as opposed to its companion checkouts. */
export const primaryRepositorySource = (sources = []) =>
  sources.find((source) => source.id === 'primary') || sources[0] || null;

export const repositoryForkDiverged = (source) => source?.forkVsUpstream?.state === 'diverged';

/**
 * Would a push to this checkout's origin fork be accepted? `canPush` is
 * tri-state: an unknown answer (no forge metadata) stays offerable, and only an
 * explicit "no" retracts the sync affordance.
 */
export const repositoryForkPushable = (source) => Boolean(source?.origin?.isFork)
  && source?.origin?.canPush !== false;

/**
 * Can a managed update fast-forward this checkout's origin fork from canonical
 * upstream? The server owns the rule (`isForkSyncable` in
 * `server/services/managedAppRepositories.js`) because the same rule decides
 * `updateAvailable`; the client reads its answer rather than re-deriving it.
 */
export const repositoryForkNeedsSync = (source) => Boolean(source?.forkSyncable)
  && (source?.forkVsUpstream?.behind || 0) > 0;

/**
 * Why an out-of-date fork is not something an update can fix, or null when it
 * is (or when the fork is current). The Git tab still reports the drift — it is
 * true and worth knowing — but must say plainly that no button here clears it.
 */
export function describeForkUnsyncable(source) {
  if ((source?.forkVsUpstream?.behind || 0) === 0) return null;
  if (repositoryForkNeedsSync(source)) return null;
  if (repositoryForkDiverged(source)) {
    return 'The fork has its own commits, so it cannot be fast-forwarded; reconcile them on GitHub first.';
  }
  if (source?.origin?.canPush === false) {
    return `PortOS can read ${source.origin.fullName || 'this fork'} but cannot push to it, so it cannot fast-forward it from upstream. Updating still pulls this checkout from the fork.`;
  }
  return 'PortOS updates companion checkouts from their own origin, so it cannot fast-forward this fork from upstream.';
}

/** `countText(2, 'commit')` → "2 commits". One phrasing for both update surfaces. */
export const countText = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * One human clause per checkout that is behind something an update would pull
 * it forward from — so a fork only counts when PortOS may fast-forward it.
 * Empty when nothing an update could move is behind.
 */
export function describeRepositorySourcesBehind(sources = []) {
  const clauses = [];
  for (const source of sources) {
    const label = source?.label || 'checkout';
    const localBehind = source?.localVsOrigin?.behind || 0;
    if (localBehind > 0) clauses.push(`${label} is ${countText(localBehind, 'commit')} behind its origin`);
    if (repositoryForkNeedsSync(source)) {
      clauses.push(`the ${label} fork is ${countText(source.forkVsUpstream.behind, 'commit')} behind upstream`);
    }
  }
  return clauses;
}
