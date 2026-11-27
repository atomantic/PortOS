import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { getProviderUsage } from '../../services/apiSystem.js';
import PageSkeleton from '../ui/PageSkeleton';
import Pill from '../ui/Pill';
import { timeAgo } from '../../utils/formatters';
import { useSocketResource } from '../../hooks/useSocketResource';
import useMounted from '../../hooks/useMounted';
import { useQuotaUpdates } from '../../hooks/useQuotaUpdates';
import ProviderQuotaBody from './ProviderQuotaBody';
import { expireQuotaWindows, groupQuotaCards, mergeRefreshedFamily, nextQuotaReset, reconcileLocalQuota } from '../../lib/quotaCards';

export const FLEET_SYNC_EVENTS = ['sync:progress'];
export const FLEET_BILLING_EVENTS = ['usage:fleet-billing-updated'];
export const isUsageSync = (payload) => payload?.phase === 'applied' && payload.category === 'usage';

const resolvesQuotaRefresh = (card) => card?.supported === false || Boolean(!card?.pending && (card?.limits?.length || card?.metrics?.length || card?.activity?.length));
const refreshDiagnostic = (card, requestOrder) => ({ ...card, requestOrder,
  ...(card.refreshUnavailable ? { error: 'Live quota refresh was unavailable; displayed readings may be out of date.', quotaStatus: undefined, quotaScope: undefined } : {}),
  refreshAttemptAt: new Date().toISOString() });

function retainedEligiblePeers(cards, result) {
  if (!Array.isArray(result.excludedInstanceIds)) return [];
  const excluded = new Set(result.excludedInstanceIds);
  return cards.filter((card) => card.origin?.self === false && !excluded.has(card.origin.instanceId));
}

// One subscription-quota card per enabled provider family. Providers with no
// queryable usage surface (supported: false) render a muted note, never an
// error; a supported adapter that failed transiently shows a soft warning.
function ProviderQuotaCard({ quota, onRefresh, refreshing, disabled, refreshError, passiveError, imageReadError }) {
  const issueText = (issue) => {
    if (!issue?.error || issue.quotaStatus === 'expired') return null;
    if (issue.quotaStatus === 'limit_reached') {
      const at = Date.parse(issue.fetchedAt);
      const window = issue.quotaScope && quota.limits?.find((limit) => limit.key === issue.quotaScope);
      const readAt = Date.parse(window?.readAt);
      if (Number.isFinite(at) && Number.isFinite(readAt) && at <= readAt) return null;
      return issue.error;
    }
    return issue.error;
  };
  let diagnostics = [...new Set([quota.providerIssue, refreshError, passiveError, imageReadError].map(issueText).filter(Boolean))];
  const bodyQuota = { ...quota, note: null };
  if (!quota.imageRefusals && !quota.limits?.length && diagnostics.length) {
    if (bodyQuota.error) diagnostics = diagnostics.filter((diagnostic) => diagnostic !== bodyQuota.error);
    else {
      bodyQuota.error = diagnostics[0];
      diagnostics = diagnostics.slice(1);
    }
  }
  return (
    <div className="min-w-0 bg-port-card border border-port-border rounded-lg p-2 sm:rounded-xl sm:p-4">
      <div className="flex items-center justify-between gap-1 sm:gap-2 mb-1 sm:mb-2">
        {/* min-w-0 so the provider name shrinks with the card instead of being
            crushed to nothing by the fixed-width controls beside it. */}
        <h3 className="min-w-0 text-sm sm:text-base font-semibold text-white truncate">{quota.label}</h3>
        <div className="flex items-center gap-1 sm:gap-2 shrink-0">
          {quota.plan && quota.plan !== 'unknown' && (
            <Pill tone="context" size="xs" className="hidden sm:inline-flex">{quota.plan}</Pill>
          )}
          {/* Per-card refresh: every family's reading is its own multi-second
              CLI/TUI scrape, so re-reading one provider must not respawn all
              of them. The button is a 44px touch target around the small
              icon; its negative margins let it overhang the header's line box
              and the card padding, so the compact phone card doesn't grow. */}
          {quota.canRefresh && <button
            type="button"
            onClick={() => onRefresh(quota.family)}
            disabled={refreshing || disabled}
            className="inline-flex items-center justify-center min-w-11 min-h-11 -my-2.5 -mr-2 text-gray-400 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
            title={`Refresh ${quota.label} usage`}
            aria-label={`Refresh ${quota.label} usage`}
          >
            {/* `will-change-transform` — see the section-level Refresh button's
                comment on the compositor-layer artifact this avoids. */}
            <RefreshCw size={14} className={`w-3 h-3 sm:w-3.5 sm:h-3.5 will-change-transform ${refreshing ? 'animate-spin' : ''}`} />
          </button>}
        </div>
      </div>

      {quota.imageRefusals ? (
        <div className="space-y-3">
          <p className="text-xs text-gray-500">Image providers do not report a quota meter.</p>
          {quota.imageRefusals.map(([key, refusal]) => <p key={key} className="text-xs text-port-warning break-words">{refusal.label || key}: refusal observed · {refusal.fetchedAt ? `reported ${timeAgo(refusal.fetchedAt, 'time unavailable')}` : 'report time unavailable'}; current availability may have changed.</p>)}
          {quota.imageObservations?.length > 0 && <p className="text-xs text-gray-500">Render counts are observations from each instance, not account-wide totals.</p>}
          {quota.imageObservations?.map((observation) => (
            <section key={observation.origin?.instanceId || 'self'} aria-label={`Image activity reported by ${observation.origin?.name || 'This instance'}`}>
              <p className="text-xs text-gray-400 mb-1 break-words">{observation.origin?.name || 'This instance'}{observation.fetchedAt ? ` · reported ${timeAgo(observation.fetchedAt, 'time unavailable')}` : ' · report time unavailable'}</p>
              <ProviderQuotaBody quota={{ ...observation, limits: [], error: undefined }} showActivity={false} showNote={false} showSource={false} />
            </section>
          ))}
        </div>
      ) : (
        <>
          <ProviderQuotaBody quota={bodyQuota} showActivity={false} showNote={false} showSource={false} />
          {quota.routingOverridden && <p className="mt-2 text-xs text-gray-500">Model routing may bypass this quota.</p>}
        </>
      )}
      {diagnostics.map((diagnostic) => <p key={diagnostic} className="mt-2 text-xs text-port-warning break-words">{diagnostic}</p>)}
    </div>
  );
}

// Desktop layout: one entry per grid cell, in display order, listing the
// families that cell holds. Claude and Antigravity each meter several windows
// and earn a cell to themselves; Codex and Grok report far less (typically a
// lone weekly window), so they share one cell stacked vertically instead of
// each padding out a half-empty full-height card.
//
// This is a fixed visual preference, deliberately NOT derived from how many
// meters a card happens to be carrying: a card's height changes between its
// pending, error, and loaded states, so a height-derived pairing would
// re-shuffle the whole grid every time a scrape landed.
const CELL_GROUPS = [['claude'], ['agy'], ['codex', 'grok']];
const GROUPED_FAMILIES = new Set(CELL_GROUPS.flat());

// Arrange the server's provider cards into grid cells: `{ key, cards[] }`, where
// a cell holding more than one card stacks them. A family absent from
// CELL_GROUPS (Image Gen, or one added later) still gets its own cell in server
// order — this is a display preference, never a filter.
export function arrangeQuotaCells(quotas) {
  const byFamily = new Map(quotas.map((q) => [q.family, q]));
  const toCell = (cards) => ({ key: cards.map((q) => q.groupKey || q.family).join('+'), cards });

  const grouped = CELL_GROUPS
    .map((families) => families.map((f) => byFamily.get(f)).filter(Boolean))
    .filter((cards) => cards.length > 0)
    .map(toCell);
  const rest = quotas.filter((q) => !GROUPED_FAMILIES.has(q.family)).map((q) => toCell([q]));

  return [...grouped, ...rest];
}

// Subscription usage for every enabled provider family (claude, codex, agy,
// grok). Self-contained fetch/loading/error state so it always renders above
// the PortOS-internal metrics.
export function ProviderQuotaSection({ billingRevision }) {
  const [quotas, setQuotas] = useState(null);
  const [loading, setLoading] = useState(true);
  const [localLoaded, setLocalLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [refreshAllError, setRefreshAllError] = useState(false);
  const [coverage, setCoverage] = useState(null);
  const [imageQuotaComplete, setImageQuotaComplete] = useState(null);
  const [imageReadError, setImageReadError] = useState(null);
  const [refreshErrors, setRefreshErrors] = useState({});
  const [passiveErrors, setPassiveErrors] = useState({});
  const [refreshingFamilies, setRefreshingFamilies] = useState(() => new Set());
  const mountedRef = useMounted();
  const [peerBillingError, setPeerBillingError] = useState(false);
  const [peerBillingLoading, setPeerBillingLoading] = useState(false);
  const quotaRequestOrder = useRef(0);
  const fullRequest = useRef({
    token: 0,
    inFlight: null,
    explicitToken: 0,
    revision: 0,
    localRevision: 0,
  });
  const familyRequests = useRef({
    orders: new Map(),
    observations: new Map(),
    localPresence: new Map(),
    revisions: new Map(),
    peerRevisions: new Map(),
    active: new Set(),
  });
  const imageStatus = useRef({ token: 0, appliedToken: 0 });
  const fleetRequests = useRef({ coverageToken: 0, billingEpoch: 0 });

  const applyImageStatus = useCallback((result, token) => {
    if (!mountedRef.current || token === null || token <= imageStatus.current.appliedToken || result?.imageQuotaComplete == null) return;
    imageStatus.current.appliedToken = token;
    setImageQuotaComplete(result.imageQuotaComplete);
    const local = result.providers?.find((card) => card.family === 'imagegen' && card.origin?.self !== false);
    setImageReadError((previous) => result.imageQuotaComplete ? null : local?.error ? local : previous);
  }, [mountedRef]);

  const load = useCallback(async (refresh = false) => {
    const families = familyRequests.current;
    const token = ++fullRequest.current.token;
    const requestOrder = ++quotaRequestOrder.current;
    const startingBillingEpoch = fleetRequests.current.billingEpoch;
    const explicitToken = refresh ? ++fullRequest.current.explicitToken : null;
    fullRequest.current.inFlight = token;
    const coverageToken = ++fleetRequests.current.coverageToken;
    const imageToken = ++imageStatus.current.token;
    const startingFamilies = new Map(families.revisions);
    setLoading(true);
    setError(false);
    if (refresh) setRefreshAllError(false);
    const result = await getProviderUsage({ refresh, scope: 'instances' }).catch(() => null);
    applyImageStatus(result, imageToken);
    const familyOrderAtCompletion = new Map(families.orders);
    // Even if a socket-driven cached read overtook Refresh all, its forced
    // scrape outcomes still matter. A newer family refresh owns that family's
    // status, so do not overwrite it with an older full request's result.
    if (refresh && mountedRef.current && explicitToken === fullRequest.current.explicitToken) {
      setRefreshAllError(!result?.providers);
      const changedFamilies = new Set([...familyOrderAtCompletion]
        .filter(([, order]) => order > requestOrder).map(([family]) => family));
      if (result?.providers) setRefreshErrors((previous) => {
        const next = { ...previous };
        const localCards = result.providers.filter((item) => item.origin?.self !== false);
        const localFamilies = new Set(localCards.map((card) => card.family));
        for (const family of Object.keys(next)) {
          if (!changedFamilies.has(family) && !localFamilies.has(family) && (family !== 'imagegen' || result.imageQuotaComplete === true)) delete next[family];
        }
        for (const card of localCards.filter((item) => !changedFamilies.has(item.family))) {
          const familyReadAt = Date.parse(families.observations.get(card.family)?.fetchedAt);
          const fullReadAt = Date.parse(card.fetchedAt);
          if (card.error && !card.refreshUnavailable && Number.isFinite(familyReadAt)
            && Number.isFinite(fullReadAt) && fullReadAt < familyReadAt) continue;
          if (card.error || card.refreshUnavailable) next[card.family] = refreshDiagnostic(card, requestOrder);
          else if (resolvesQuotaRefresh(card)) delete next[card.family];
        }
        return next;
      });
      // A successful explicit read supersedes older passive diagnostics, but
      // not a passive read that started after this request.
      if (result?.providers) setPassiveErrors((previous) => {
        const next = { ...previous };
        const localCards = result.providers.filter((card) => card.origin?.self !== false);
        const present = new Set(localCards.map((card) => card.family));
        for (const family of Object.keys(next)) {
          const newerFamily = (familyOrderAtCompletion.get(family) || 0) > requestOrder;
          if (!newerFamily && (next[family]?.requestOrder || 0) <= requestOrder && !present.has(family)
            && (family !== 'imagegen' || result.imageQuotaComplete === true)) delete next[family];
        }
        for (const card of localCards) {
          const newerFamily = (familyOrderAtCompletion.get(card.family) || 0) > requestOrder;
          if (!newerFamily && (next[card.family]?.requestOrder || 0) <= requestOrder
            && !card.error && !card.refreshUnavailable && resolvesQuotaRefresh(card)) delete next[card.family];
        }
        return next;
      });
    }
    if (token !== fullRequest.current.token) return;
    fullRequest.current.inFlight = null;
    if (result?.providers) {
      setLocalLoaded(true);
      const billingChanged = startingBillingEpoch !== fleetRequests.current.billingEpoch;
      if (!refresh) {
        // A family request only supersedes reads that began before it. A newer
        // passive failure must remain visible while an older refresh finishes.
        const changedFamilies = new Set([...familyOrderAtCompletion]
          .filter(([, order]) => order > requestOrder).map(([family]) => family));
        const localCards = result.providers.filter((card) => card.origin?.self !== false && !changedFamilies.has(card.family));
        // A definitive removal also retires the local refresh failure. Do not
        // clear a failure merely because a cached read of a present provider
        // succeeded, and never infer removal from an incomplete image read.
        setRefreshErrors((previous) => {
          let next = previous;
          for (const [family, diagnostic] of Object.entries(previous)) {
            const local = localCards.find((card) => card.family === family);
            if (changedFamilies.has(family) || (diagnostic.requestOrder || 0) > requestOrder
              || (family === 'imagegen' && result.imageQuotaComplete !== true)
              || (local && local.supported !== false)) continue;
            if (next === previous) next = { ...previous };
            delete next[family];
          }
          return next;
        });
        setPassiveErrors((previous) => {
          const next = { ...previous };
          const present = new Set(localCards.map((card) => card.family));
          for (const family of Object.keys(next)) {
            if (!changedFamilies.has(family) && !present.has(family)
              && (family !== 'imagegen' || result.imageQuotaComplete === true)) delete next[family];
          }
          for (const card of localCards) {
            if (card.error || card.refreshUnavailable) next[card.family] = refreshDiagnostic(card, requestOrder);
            else if (resolvesQuotaRefresh(card)) delete next[card.family];
          }
          return next;
        });
      }
      const localCards = result.providers.filter((card) => card.origin?.self !== false);
      const byFamily = new Map(localCards.map((card) => [card.family, card]));
      const knownFamilies = new Set([...families.localPresence.keys(), ...families.orders.keys(), ...byFamily.keys()]);
      for (const family of knownFamilies) {
        // An incomplete image read says neither that the provider exists nor
        // that it was removed; keep the last definitive observation.
        if (family === 'imagegen' && result.imageQuotaComplete !== true) continue;
        families.localPresence.set(family, { order: requestOrder, card: byFamily.get(family) || null });
      }
      const presence = new Map(families.localPresence);
      const familyOrders = familyOrderAtCompletion;
      fullRequest.current.localRevision += 1;
      if (!result.federationUnavailable && !billingChanged) {
        fullRequest.current.revision += 1;
        setPeerBillingError(false);
      }
      // A family refresh can finish while this full read is in flight. Retain
      // its newer local card while still taking the full read's peer cards.
      const active = new Set(families.active);
      const preserve = new Set(active);
      for (const [family, revision] of families.revisions) {
        if (revision !== (startingFamilies.get(family) || 0)) preserve.add(family);
      }
      if (result.imageQuotaComplete === false) preserve.add('imagegen');
      setQuotas((previous) => {
        if (!previous) return billingChanged ? result.providers.filter((card) => card.origin?.self !== false) : result.providers;
        const priorLocals = previous.filter((card) => card.origin?.self !== false);
        const priorFamilies = new Set(priorLocals.map((card) => card.family));
        const peers = billingChanged ? previous.filter((card) => card.origin?.self === false)
          : result.federationUnavailable ? retainedEligiblePeers(previous, result)
            : result.providers.filter((card) => card.origin?.self === false);
        return [
          ...peers,
          ...result.providers.filter((card) => card.origin?.self !== false && (!preserve.has(card.family) || !priorFamilies.has(card.family)))
            .map((card) => reconcileLocalQuota(priorLocals.find((prior) => prior.family === card.family), card)),
          ...priorLocals.filter((card) => preserve.has(card.family)).flatMap((card) => {
            const familyIsNewer = (familyOrders.get(card.family) || 0) > requestOrder;
            const observed = presence.get(card.family);
            if (!familyIsNewer && observed?.order === requestOrder && !observed.card) return [];
            if (!familyIsNewer && observed?.order === requestOrder && observed.card?.supported === false) return [observed.card];
            if (!active.has(card.family)) return [card];
            const incoming = result.providers.find((item) => item.origin?.self !== false && item.family === card.family);
            return [incoming && incoming.supported !== false ? reconcileLocalQuota(card, incoming, { preferNewer: true }) : card];
          }),
        ];
      });
      if (!billingChanged && coverageToken === fleetRequests.current.coverageToken) setCoverage(result);
    } else {
      // Keep previously-loaded cards on a transient refresh failure.
      setError(true);
    }
    setLoading(false);
  }, [applyImageStatus, mountedRef]);

  useEffect(() => {
    load();
    return () => {
      fullRequest.current.token += 1;
      fullRequest.current.inFlight = null;
    };
  }, [load]);

  // One deadline-based timer updates the UI at the earliest known reset. A
  // longer delay is re-armed at the browser timeout limit, without polling.
  useEffect(() => {
    const reset = nextQuotaReset(quotas);
    if (reset === null) return undefined;
    const maxDelay = 2_147_483_647;
    let timer;
    const schedule = () => {
      const remaining = reset - Date.now();
      timer = setTimeout(() => {
        if (!mountedRef.current) return;
        if (reset > Date.now()) schedule();
        else setQuotas((previous) => previous ? expireQuotaWindows(previous) : previous);
      }, Math.min(Math.max(remaining, 0), maxDelay));
    };
    schedule();
    return () => clearTimeout(timer);
  }, [quotas, mountedRef]);

  // Refresh ONE provider card. The whole-section Refresh spawns every family's
  // scrape at once (10-20s each); this asks for the single card the user
  // clicked and swaps it in when the reading lands, leaving every other card's
  // reading — and its age — untouched. A failure toasts through the request
  // helper; the catch here only clears the spinner, it owns no error UI.
  const refreshFamily = useCallback(async (family) => {
    const families = familyRequests.current;
    const startingFullRevision = fullRequest.current.revision;
    const startingLocalFullRevision = fullRequest.current.localRevision;
    const requestOrder = ++quotaRequestOrder.current;
    families.orders.set(family, requestOrder);
    const startingBillingEpoch = fleetRequests.current.billingEpoch;
    const coverageToken = ++fleetRequests.current.coverageToken;
    const imageToken = family === 'imagegen' ? ++imageStatus.current.token : null;
    const revision = (families.revisions.get(family) || 0) + 1;
    families.revisions.set(family, revision);
    families.active.add(family);
    setRefreshingFamilies((prev) => new Set(prev).add(family));
    const result = await getProviderUsage({ refresh: true, family, scope: 'instances', silent: false }).catch(() => null);
    if (!mountedRef.current || families.revisions.get(family) !== revision) return;
    applyImageStatus(result, imageToken);
    families.active.delete(family);
    // A full read may have started after this refresh began; advancing again
    // records that its response predates the refresh completion.
    families.revisions.set(family, revision + 1);
    if (result?.providers) {
      // No card back for a family we asked for means it is no longer enabled
      // (its provider was turned off) — drop it rather than leave a reading
      // that can never refresh again. `prev` is always an array here: the
      // button that got us here only renders once quotas have loaded.
      const billingChanged = startingBillingEpoch !== fleetRequests.current.billingEpoch;
      const fullReadApplied = billingChanged || startingFullRevision !== fullRequest.current.revision;
      const localFullReadApplied = startingLocalFullRevision !== fullRequest.current.localRevision;
      const local = result.providers.find((card) => card.family === family && card.origin?.self !== false);
      const presence = families.localPresence.get(family);
      const newerRemoval = presence?.order > requestOrder && (!presence.card || presence.card.supported === false);
      if (!newerRemoval && local && !local.error && !local.refreshUnavailable && local.supported !== false && resolvesQuotaRefresh(local)) {
        families.observations.set(family, local);
      }
      const familyProviders = newerRemoval
        ? [...result.providers.filter((card) => card.origin?.self === false), ...(presence.card ? [presence.card] : [])]
        : result.providers;
      const localUnavailable = !newerRemoval && family === 'imagegen'
        && (result.imageQuotaComplete === false || (!local && result.imageQuotaComplete !== true));
      if (!billingChanged && !result.federationUnavailable) {
        families.peerRevisions.set(family, (families.peerRevisions.get(family) || 0) + 1);
      }
      const providers = billingChanged ? familyProviders.filter((card) => card.origin?.self !== false) : familyProviders;
      setQuotas((prev) => {
        const safePrevious = !billingChanged && result.federationUnavailable
          ? [...prev.filter((card) => card.origin?.self !== false), ...retainedEligiblePeers(prev, result)] : prev;
        return mergeRefreshedFamily(safePrevious, providers, family, { fullReadApplied, localFullReadApplied, federationUnavailable: result.federationUnavailable, localUnavailable });
      });
      setRefreshErrors((previous) => {
        const next = { ...previous };
        if (newerRemoval) {
          if ((next[family]?.requestOrder || 0) <= presence.order) delete next[family];
          return next;
        }
        if ((next[family]?.requestOrder || 0) > requestOrder) return previous;
        if (local?.error || local?.refreshUnavailable) next[family] = refreshDiagnostic(local, requestOrder);
        else if ((!local && !localUnavailable) || resolvesQuotaRefresh(local)) delete next[family];
        return next;
      });
      if (newerRemoval || ((!local && !localUnavailable)
        || (local && !local.error && !local.refreshUnavailable && resolvesQuotaRefresh(local)))) setPassiveErrors((previous) => {
        if ((previous[family]?.requestOrder || 0) > (newerRemoval ? presence.order : requestOrder)) return previous;
        const next = { ...previous };
        delete next[family];
        return next;
      });
      if (!billingChanged && coverageToken === fleetRequests.current.coverageToken) setCoverage(result);
      // The older full response may contain an older peer slot even when it
      // preserves this local refresh. Supersede it with a fresh cached read.
      if (fullRequest.current.inFlight !== null) void load();
    } else {
      // A full read may have preserved the old card while this refresh was
      // pending. Reconcile after a failure so its newer result is not lost.
      void load();
    }
    setRefreshingFamilies((prev) => {
      const next = new Set(prev);
      next.delete(family);
      return next;
    });
  }, [load, applyImageStatus, mountedRef]);

  // Billing invalidations carry no account data. Discard unverified peer cards
  // immediately, even when a prior peer read is still in flight.
  const invalidateBillingPeers = useCallback(() => {
    const epoch = ++fleetRequests.current.billingEpoch;
    fleetRequests.current.coverageToken += 1;
    setPeerBillingLoading(true);
    setPeerBillingError(false);
    setQuotas((previous) => previous?.filter((card) => card.origin?.self !== false) ?? previous);
    return epoch;
  }, []);

  // Reload only saved eligible peers; this scope never starts a CLI scrape.
  const reloadBillingPeers = useCallback(async () => {
    const epoch = invalidateBillingPeers();
    const startingFullRevision = fullRequest.current.revision;
    const startingFamilies = new Map(familyRequests.current.peerRevisions);
    const coverageToken = fleetRequests.current.coverageToken;
    const result = await getProviderUsage({ scope: 'peers', silent: true }).catch(() => null);
    if (!mountedRef.current || epoch !== fleetRequests.current.billingEpoch) return;
    setPeerBillingLoading(false);
    if (startingFullRevision !== fullRequest.current.revision) return;
    if (!result?.providers || result.federationUnavailable) {
      setPeerBillingError(true);
      return;
    }
    const changedFamilies = new Set();
    for (const [family, revision] of familyRequests.current.peerRevisions) {
      if (revision !== (startingFamilies.get(family) || 0)) changedFamilies.add(family);
    }
    setQuotas((previous) => [
      ...(previous || []).filter((card) => card.origin?.self !== false),
      ...result.providers.filter((card) => !changedFamilies.has(card.family)),
      ...(previous || []).filter((card) => card.origin?.self === false && changedFamilies.has(card.family)),
    ]);
    if (coverageToken === fleetRequests.current.coverageToken) setCoverage(result);
  }, [invalidateBillingPeers, mountedRef]);

  useEffect(() => { if (billingRevision) void reloadBillingPeers(); }, [billingRevision, reloadBillingPeers]);
  useSocketResource(() => reloadBillingPeers(), { events: FLEET_BILLING_EVENTS, immediate: false,
    matchesEvent: () => { invalidateBillingPeers(); return true; } });

  // Cards still being scraped come back `pending`; completion events reload them. See hooks/useQuotaUpdates.js.
  useQuotaUpdates(load);
  useSocketResource(() => load(), { namespace: 'instances', events: FLEET_SYNC_EVENTS, matchesEvent: isUsageSync, immediate: false });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-xl sm:text-2xl font-bold text-white">Subscription quotas</h2>
        <button
          type="button"
          onClick={() => load(true)}
          disabled={loading}
          className="flex items-center justify-center gap-1.5 min-w-11 min-h-11 -my-2 px-2 sm:px-3 text-xs sm:text-sm text-gray-400 hover:text-white disabled:opacity-50"
          title="Refresh every provider's usage"
        >
          {/* `will-change-transform` promotes the icon to its own compositor
              layer before `animate-spin` starts — without it this button's
              continuous rotate restarts each poll and can leave a stale
              rasterized frame behind the live one on some GPUs. */}
          <RefreshCw size={15} className={`will-change-transform ${loading ? 'animate-spin' : ''}`} /> Refresh all
        </button>
      </div>

      <p className="text-xs text-gray-500">Readings from the same provider are assumed to share an account. The latest available reading for each quota window is shown; allowances are not added.</p>
      {coverage?.federationUnavailable && <p className="text-xs text-port-warning" role="status">Some peer quota readings are unavailable; displayed quotas may be incomplete.</p>}
      {peerBillingLoading && <p className="text-xs text-gray-500" role="status">Updating peer quota readings…</p>}
      {peerBillingError && <p className="text-xs text-port-warning" role="status">Couldn&rsquo;t update peer quota readings; displayed quotas may be incomplete.</p>}
      {imageQuotaComplete === false && <p className="text-xs text-port-warning">Image quota status is unavailable.</p>}
      {error && localLoaded && <p className="text-xs text-port-warning">Couldn&rsquo;t refresh quota readings; retained readings may be stale.</p>}
      {refreshAllError && !error && <p className="text-xs text-port-warning">Couldn&rsquo;t refresh all provider quotas; retained readings may be stale.</p>}

      {loading && !localLoaded && (
        // Reserve the quota-card grid below rather than a centered spinner
        // (#4147) — the cards are the whole section, so the reading arriving
        // shouldn't jump the page down by their height.
        <PageSkeleton
          header="none"
          label="Reading provider usage"
          layout="grid"
          gridColsClass="grid-cols-2 sm:grid-cols-1 lg:grid-cols-2"
          cards={4}
        />
      )}

      {!loading && error && !localLoaded && (
        <div className="flex items-start gap-2 text-sm text-gray-400 py-2">
          <AlertTriangle size={16} className="text-port-warning mt-0.5 shrink-0" />
          <span>Couldn&rsquo;t read provider usage.</span>
        </div>
      )}

      {quotas && (localLoaded || !loading) && (
        // `contents` makes the grouped desktop cells transparent to the mobile
        // grid, so each provider gets its own compact cell without duplicating
        // the card tree (which would confuse screen readers and text queries).
        <div className="grid grid-cols-2 sm:grid-cols-1 lg:grid-cols-2 gap-2 sm:gap-3 lg:gap-4 items-start" aria-label="Subscription provider usage">
          {arrangeQuotaCells(groupQuotaCards(quotas)).map((cell) => (
            <div key={cell.key} className="contents sm:block sm:space-y-4">
              {cell.cards.map((quota) => (
                <ProviderQuotaCard
                  key={quota.groupKey}
                  quota={quota}
                  onRefresh={refreshFamily}
                  refreshing={refreshingFamilies.has(quota.family)}
                  disabled={loading}
                  refreshError={refreshErrors[quota.family]}
                  passiveError={passiveErrors[quota.family]}
                  imageReadError={quota.family === 'imagegen' ? imageReadError : null}
                />
              ))}
            </div>
          ))}
          {quotas.length === 0 && localLoaded && (
            <div className="col-span-2 sm:col-span-1 text-gray-500 text-sm">No enabled providers report subscription usage.</div>
          )}
        </div>
      )}
    </div>
  );
}

export default ProviderQuotaSection;
