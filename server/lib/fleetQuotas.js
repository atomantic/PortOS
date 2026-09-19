/**
 * Federated subscription-quota readings — the pure half of "one plan, several
 * machines".
 *
 * A PortOS user commonly runs several federated installs against the SAME
 * provider subscription, but each install can only read the quota panel of its
 * own local CLI. That made every card a partial view: this machine's reading,
 * captioned "local sessions only". The `usage` sync category now carries each
 * instance's last quota reading alongside its usage digest, and these functions
 * unify them into one card per family.
 *
 * Two different merge rules, because the two halves of a card mean different
 * things:
 *
 *  - **limits** (the meters) are ACCOUNT-wide — every machine reads the same
 *    server-side allowance, just at a different moment. So the freshest reading
 *    per limit key wins; summing them would multiply one allowance by the
 *    number of machines that looked at it.
 *  - **activity** (requests/sessions) is LOCAL to the machine that ran the
 *    work, which is exactly why the provider captions it "does not include
 *    other devices". Those sum.
 *
 * `metrics[]` is deliberately left alone: its values are prose
 * (`"3 renders · 24h"`), not addends, so there is nothing to unify honestly.
 */

import { compareNewerWins, parseTsMs } from './lwwTimestamp.js';
import { limitWindowExpired } from './quotaReset.js';
import { isLimitStale } from './quotaWindows.js';
import { isNonBlankStr } from './textUtils.js';

// Structural bounds on ONE peer-supplied quota payload. Same reasoning as the
// usage digest's caps in services/peerUsage.js: the wire shape is fixed and
// shallow, so it is rebuilt field-by-field rather than stored as it arrived.
export const MAX_FLEET_QUOTA_CARDS = 16;
const MAX_LIMITS_PER_CARD = 24;
const MAX_ACTIVITY_PER_CARD = 12;
const MAX_NOTES_PER_ACTIVITY = 8;
// How many instance names a note spells out before collapsing the tail.
const NOTE_NAME_LIMIT = 3;

const str = (v, max) => (isNonBlankStr(v) ? v.slice(0, max) : null);
const int = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
const pct = (v) => {
  const n = int(v);
  return n === null ? null : Math.min(100, Math.max(0, n));
};

function sanitizeLimit(raw) {
  const key = str(raw?.key, 120);
  if (!key) return null;
  const percentUsed = pct(raw?.percentUsed);
  const periodHours = Number.isFinite(raw?.periodHours) && raw.periodHours > 0 ? raw.periodHours : null;
  return {
    key,
    label: str(raw?.label, 200) || key,
    percentUsed,
    percentRemaining: percentUsed === null ? null : 100 - percentUsed,
    resetsAt: str(raw?.resetsAt, 60),
    timezone: str(raw?.timezone, 60),
    // How long this window's allowance lasts, when the adapter states it
    // exactly (`lib/quotaWindows.js`'s `windowPeriodHours`). Additive and
    // back-compatible: an older peer simply omits it, and staleness falls back
    // to the scope-word classifier. Carried through so a federated merge can
    // age a peer's reading against its own window, not just a local one.
    ...(periodHours !== null ? { periodHours } : {}),
  };
}

function sanitizeActivity(raw) {
  const period = str(raw?.period, 60);
  if (!period) return null;
  const notes = Array.isArray(raw?.notes)
    ? raw.notes.slice(0, MAX_NOTES_PER_ACTIVITY).map((n) => str(n, 200)).filter(Boolean)
    : [];
  return { period, requests: int(raw?.requests) ?? 0, sessions: int(raw?.sessions) ?? 0, notes };
}

/**
 * Rebuild a peer's quota payload to the known wire shape, dropping anything
 * else. Cards without a family id, and limits without a key, are unmergeable
 * and are dropped rather than stored.
 */
export function sanitizeQuotaCards(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const card of raw.slice(0, MAX_FLEET_QUOTA_CARDS)) {
    const family = str(card?.family, 60);
    if (!family) continue;
    const limits = (Array.isArray(card?.limits) ? card.limits : [])
      .slice(0, MAX_LIMITS_PER_CARD).map(sanitizeLimit).filter(Boolean);
    const activity = (Array.isArray(card?.activity) ? card.activity : [])
      .slice(0, MAX_ACTIVITY_PER_CARD).map(sanitizeActivity).filter(Boolean);
    // A reading with nothing to contribute is not worth a wire slot.
    if (!limits.length && !activity.length) continue;
    out.push({
      family,
      label: str(card?.label, 120) || family,
      plan: str(card?.plan, 60),
      limits,
      activity,
      fetchedAt: str(card?.fetchedAt, 40),
    });
  }
  return out;
}

/**
 * Does this card carry numbers to act on?
 *
 * The one question every `pending` consumer actually asks. `pending` means
 * "this machine's scrape is in flight" — which, since a federated peer's
 * reading can fill the meters meanwhile, no longer implies "empty". Consumers
 * that need a number (the burn gate) or that choose between a spinner and
 * meters ask this instead of re-deriving it from the flag.
 */
export const cardHasReading = (card) => Boolean(card?.limits?.length || card?.metrics?.length);

/** The most recent `fetchedAt` in a set of cards, or null when none parses. */
export const latestFetchedAt = (cards) => (Array.isArray(cards) ? cards : []).reduce((latest, card) => {
  const ms = parseTsMs(card?.fetchedAt);
  if (ms === null) return latest;
  return latest === null || ms > parseTsMs(latest) ? card.fetchedAt : latest;
}, null);

/**
 * Freshest reading per limit key across contributors, keeping the local card's
 * ordering first and appending keys only a peer reported (a window this
 * machine's CLI has not surfaced yet is still real).
 *
 * Every surviving limit carries WHEN it was read (`readAt`) and BY WHICH
 * instance, so a consumer can age a stand-in reading instead of presenting a
 * peer's day-old meter as this moment's number. `readBy` is null for the local
 * contribution, which is how the UI tells "this machine" from a stand-in.
 *
 * `stale` is recomputed here rather than carried over from whichever
 * contribution stamped it: the winning reading's `readAt` becomes the WINNING
 * contribution's `fetchedAt`, which can differ from what the limit itself was
 * last judged against (a peer's own stamp, taken at a different `now`) — so
 * the verdict has to be re-derived against this merge's own `now` and the
 * limit's own window period (`lib/quotaWindows.js`), the same rule a
 * single-machine card applies.
 */
function unifyLimits(contributions, now) {
  const best = new Map();
  const order = [];
  for (const c of contributions) {
    for (const limit of c.limits || []) {
      // A window whose reset has passed is not a reading of the current
      // allowance — drop it rather than let it win its key on freshness.
      if (limitWindowExpired(limit, { now })) continue;
      const incumbent = best.get(limit.key);
      if (!incumbent) order.push(limit.key);
      // Unparseable-loses, tie → incumbent: the shared LWW polarity, so the
      // local reading (always first) holds a tie.
      if (!incumbent || compareNewerWins(c.fetchedAt, incumbent.fetchedAt)) {
        best.set(limit.key, { limit, fetchedAt: c.fetchedAt, instanceId: c.instanceId, name: c.name });
      }
    }
  }
  return order.map((key) => {
    const { limit, fetchedAt, instanceId, name } = best.get(key);
    const readAt = fetchedAt ?? null;
    const readAtMs = parseTsMs(readAt);
    const ageMs = readAtMs === null ? null : now - readAtMs;
    return { ...limit, readAt, readBy: instanceId, readByName: name, stale: isLimitStale(limit, ageMs) };
  });
}

/** Sum requests/sessions per period; a period only some instances report still counts. */
function unifyActivity(contributions) {
  const byPeriod = new Map();
  for (const c of contributions) {
    for (const entry of c.activity || []) {
      const existing = byPeriod.get(entry.period);
      if (!existing) {
        byPeriod.set(entry.period, { ...entry, notes: [...(entry.notes || [])] });
        continue;
      }
      existing.requests += entry.requests || 0;
      existing.sessions += entry.sessions || 0;
    }
  }
  return [...byPeriod.values()];
}

const nameList = (contributions) => {
  const names = contributions.map((c) => (c.self ? 'this machine' : c.name || c.instanceId));
  if (names.length <= NOTE_NAME_LIMIT) return names.join(', ');
  const rest = names.length - NOTE_NAME_LIMIT;
  return `${names.slice(0, NOTE_NAME_LIMIT).join(', ')} +${rest} more`;
};

/**
 * The caption that replaces the provider's own "local sessions only" wording
 * once a card actually spans machines. It names what was unified so the number
 * on screen is falsifiable — a meter attributed to one instance and a summed
 * activity count are different claims.
 */
export function fleetNote(contributions, { hasActivity }) {
  const count = contributions.length;
  const what = hasActivity
    ? 'meters show the freshest reading, activity is summed'
    : 'meters show the freshest reading across them';
  return `Across ${count} federated instances (${nameList(contributions)}) — ${what}.`;
}

/**
 * Unify one family's card with the readings peers published for it.
 *
 * `peerCards` are the same family's cards from other instances, each carrying
 * its origin. Fewer than one contributing peer leaves the local card untouched,
 * caption included — a single-machine install has nothing to combine, and
 * claiming otherwise would be worse than the wording this replaces.
 */
export function mergeQuotaCard(local, peerCards = [], now = Date.now()) {
  const localContribution = {
    instanceId: local.instanceId || null,
    name: local.name || null,
    self: true,
    fetchedAt: local.fetchedAt || null,
    limits: local.limits || [],
    activity: local.activity || [],
  };
  const contributions = [localContribution, ...peerCards.filter((c) => (c.limits?.length || c.activity?.length))];
  if (contributions.length < 2) return local;

  const limits = unifyLimits(contributions, now);
  const activity = unifyActivity(contributions);
  // Plan/tier is account-wide, same as the meters: take the freshest named
  // reading so a card this machine could not label still shows SuperGrok/Pro
  // when a peer's scrape (or a later local one) named it.
  const planReadings = [
    { plan: local.plan, fetchedAt: local.fetchedAt },
    ...peerCards.map((c) => ({ plan: c.plan, fetchedAt: c.fetchedAt })),
  ].filter((c) => isNonBlankStr(c.plan) && c.plan !== 'unknown');
  const plan = planReadings.length
    ? planReadings.reduce((best, c) => (compareNewerWins(c.fetchedAt, best.fetchedAt) ? c : best)).plan
    : local.plan;
  const fleet = {
    instances: contributions.map(({ instanceId, name, self, fetchedAt }) => ({ instanceId, name, self, fetchedAt })),
    // Which machines are represented, for a UI that wants to age the reading
    // without re-deriving it from `instances`.
    count: contributions.length,
  };
  return {
    ...local,
    plan,
    limits,
    activity,
    fleet,
    // A local card that could not be read (a logged-out CLI) is no longer empty
    // once a peer has read the SAME account — so it stops reporting a failure it
    // no longer has.
    //
    // `pending` is NOT cleared that way, because it does not mean "empty": it
    // means THIS machine's reading is in flight and will land in a moment. The
    // Usage page polls while any card is pending and stops when none is, so
    // clearing it here ended the poll on the peer's stand-in numbers — a
    // days-old "12% used" sat on screen as the current weekly figure until the
    // user hit Refresh by hand, then came back at the next cold cache.
    // A peer's reading fills the card meanwhile; the poll swaps in this
    // machine's the moment it arrives.
    pending: local.pending,
    error: limits.length ? null : local.error,
    note: fleetNote(contributions, { hasActivity: activity.length > 0 }),
  };
}

/**
 * Unify every local card with the fleet's readings.
 *
 * Only families this install actually has enabled get a card — a peer running a
 * provider we don't is that machine's business, and inventing a card here would
 * put a meter on screen for a plan the viewer can't spend.
 */
export function mergeFleetQuotaCards(localCards, peerEntries = [], { now = Date.now() } = {}) {
  const cards = Array.isArray(localCards) ? localCards : [];
  if (!cards.length || !peerEntries.length) return cards;
  const byFamily = new Map();
  for (const entry of peerEntries) {
    for (const card of entry.quotas || []) {
      const list = byFamily.get(card.family) || [];
      list.push({ ...card, instanceId: entry.instanceId, name: entry.name, self: false });
      byFamily.set(card.family, list);
    }
  }
  return cards.map((card) => mergeQuotaCard(card, byFamily.get(card.family) || [], now));
}
