import PageHeader from '../components/PageHeader';
import PageLayout from '../components/PageLayout';
import { useCallback, useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router';
import { RefreshCw, AlertTriangle, DatabaseZap, Network, BarChart3 } from 'lucide-react';
import * as api from '../services/api';
import BrailleSpinner from '../components/BrailleSpinner';
import PageSkeleton from '../components/ui/PageSkeleton';
import Pill from '../components/ui/Pill';
import { formatCompactCountOrDash as formatNumber, formatCount, formatUsd, timeAgo } from '../utils/formatters';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { useSocketResource } from '../hooks/useSocketResource';
import { useQuotaUpdates } from '../hooks/useQuotaUpdates';
import SubscriptionSavingsCard from '../components/usage/SubscriptionSavingsCard';
import ClaudeCodeModelTokensCard from '../components/usage/ClaudeCodeModelTokensCard';
import FleetUsageCard from '../components/usage/FleetUsageCard';
import MonthlyUsageCard from '../components/usage/MonthlyUsageCard';
import RollingCostCard from '../components/usage/RollingCostCard';
import FreeTierUsageCard from '../components/usage/FreeTierUsageCard';
import ProviderQuotaBody from '../components/usage/ProviderQuotaBody';
import ModelsTabsHeader from '../components/models/ModelsTabsHeader';
import { USAGE_PERIOD_OPTIONS, DEFAULT_USAGE_PERIOD } from '../lib/usagePeriods';
import { groupQuotaCards, mergeRefreshedFamily } from '../lib/quotaCards';


const BACKFILL_EVENTS = ['usage-backfill:updated'];
const IMAGE_USAGE_EVENTS = ['image-gen:completed'];
const FLEET_SYNC_EVENTS = ['sync:progress'];
const isUsageSync = (payload) => payload?.phase === 'applied' && payload.category === 'usage';
const resolvesQuotaRefresh = (card) => card?.supported === false || Boolean(!card?.pending && (card?.limits?.length || card?.metrics?.length || card?.activity?.length));

function joinAnd(parts) {
  if (parts.length <= 1) return parts[0] || '';
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}`;
}

/** What Reconcile now added to the Grok ledger. Absent until that job finishes. */
function grokRepairLine(grok) {
  if (!grok) return '';
  const parts = [];
  if (grok.turns) parts.push(`${formatCount(grok.turns)} long-context turn${grok.turns === 1 ? '' : 's'}`);
  if (grok.images) parts.push(`${formatCount(grok.images)} image${grok.images === 1 ? '' : 's'}`);
  if (grok.videos) parts.push(`${formatCount(grok.videos)} video${grok.videos === 1 ? '' : 's'}`);
  const added = parts.length ? `Added ${joinAnd(parts)}.` : 'Grok usage was already recorded.';
  return grok.note ? `${added} ${grok.note}` : added;
}

/** What Reconcile now added to the Antigravity ledger. Absent until that job finishes. */
function agyRepairLine(agy) {
  if (!agy) return '';
  const parts = [];
  if (agy.images) parts.push(`${formatCount(agy.images)} image${agy.images === 1 ? '' : 's'}`);
  const added = parts.length ? `Added ${joinAnd(parts)}.` : 'Antigravity usage was already recorded.';
  return agy.note ? `${added} ${agy.note}` : added;
}

// Name the instances that supplied readings without presenting their quota
// observations as separate allowances or summing them.
function FleetSourcesPill({ fleet }) {
  if (!fleet || fleet.count < 2) return null;
  const describe = (i) => `${i.self ? 'this machine' : (i.name || i.instanceId)}${i.self || !i.fetchedAt ? '' : ` (read ${timeAgo(i.fetchedAt, 'time unavailable')})`}`;
  return (
    <Pill tone="context" size="xs" icon={Network} className="hidden sm:inline-flex shrink-0" title={fleet.instances.map(describe).join(' · ')}>
      {fleet.count} instances
    </Pill>
  );
}

// One subscription-quota card per enabled provider family. Providers with no
// queryable usage surface (supported: false) render a muted note, never an
// error; a supported adapter that failed transiently shows a soft warning.
function ProviderQuotaCard({ quota, onRefresh, refreshing, disabled, refreshError, imageReadError }) {
  const diagnostics = quota.observations ? [] : [...(quota.diagnostics || [])];
  for (const error of [refreshError, imageReadError].filter(Boolean)) {
    const sameLocalError = (card) => card.origin?.self !== false && card.error === error.error;
    if (!sameLocalError(quota) && !diagnostics.some(sameLocalError)
      && !quota.observations?.some(sameLocalError)) diagnostics.push(error);
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
          <FleetSourcesPill fleet={quota.fleet} />
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

      {quota.observations ? (
        <div className="space-y-3">
          <p className="text-xs text-gray-500">Image limits and counts are observations from each instance, not account-wide quotas or totals.</p>
          {quota.observations.map((observation, index) => (
            <div key={observation.origin?.instanceId || `self-${index}`}>
              <p className="text-xs text-gray-400 mb-1 break-words">{observation.origin?.name || 'This instance'}{observation.fetchedAt ? ` · reported ${timeAgo(observation.fetchedAt, 'time unavailable')}` : ' · report time unavailable'}</p>
              <ProviderQuotaBody quota={observation} />
            </div>
          ))}
        </div>
      ) : (
        <>
          {quota.origin && <p className="text-xs text-gray-400 mb-2 break-words">{quota.origin.name || 'This instance'}{quota.fetchedAt ? ` · read ${timeAgo(quota.fetchedAt, 'time unavailable')}` : ' · reading time unavailable'}{quota.mixedReadings ? ' · some windows use earlier reports' : ''}</p>}
          <ProviderQuotaBody quota={quota} />
          {quota.activity?.length > 0 && <p className="mt-2 text-xs text-gray-500">Activity is observed on the selected instance and is not a fleet total.</p>}
          {quota.localAdvisories?.map((note, index) => <p key={index} className="mt-2 text-xs text-gray-500 break-words">This instance: {note}</p>)}
        </>
      )}
      {diagnostics.map((diagnostic, index) => (
        <p key={diagnostic.origin?.instanceId || `self-${index}`} className="mt-2 text-xs text-port-warning break-words">
          {diagnostic.refreshAttemptAt ? 'Last refresh on this instance' : (diagnostic.origin?.name || 'This instance')}{diagnostic.refreshAttemptAt || diagnostic.fetchedAt ? ` · ${timeAgo(diagnostic.refreshAttemptAt || diagnostic.fetchedAt, 'time unavailable')}` : ' · time unavailable'}: {diagnostic.error} Earlier readings may be out of date.
        </p>
      ))}
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
function ProviderQuotaSection() {
  const [quotas, setQuotas] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [refreshAllError, setRefreshAllError] = useState(false);
  const [coverage, setCoverage] = useState(null);
  const [imageQuotaComplete, setImageQuotaComplete] = useState(null);
  const [imageReadError, setImageReadError] = useState(null);
  const [refreshErrors, setRefreshErrors] = useState({});
  const [refreshingFamilies, setRefreshingFamilies] = useState(() => new Set());
  const quotaRequest = useRef(0);
  const fullInFlight = useRef(null);
  const mounted = useRef(false);
  const explicitRequest = useRef(0);
  const fullRevision = useRef(0);
  const coverageRequest = useRef(0);
  const imageStatusRequest = useRef(0);
  const imageStatusApplied = useRef(0);
  const familyRevisions = useRef(new Map());
  const activeFamilies = useRef(new Set());

  const applyImageStatus = useCallback((result, token) => {
    if (!mounted.current || token === null || token <= imageStatusApplied.current || result?.imageQuotaComplete == null) return;
    imageStatusApplied.current = token;
    setImageQuotaComplete(result.imageQuotaComplete);
    const local = result.providers?.find((card) => card.family === 'imagegen' && card.origin?.self !== false);
    setImageReadError((previous) => result.imageQuotaComplete ? null : local?.error ? local : previous);
  }, []);

  const load = useCallback(async (refresh = false) => {
    const token = ++quotaRequest.current;
    const explicitToken = refresh ? ++explicitRequest.current : null;
    fullInFlight.current = token;
    const coverageToken = ++coverageRequest.current;
    const imageToken = ++imageStatusRequest.current;
    const startingFamilies = new Map(familyRevisions.current);
    setLoading(true);
    setError(false);
    if (refresh) setRefreshAllError(false);
    const result = await api.getProviderUsage({ refresh, scope: 'instances' }).catch(() => null);
    applyImageStatus(result, imageToken);
    // Even if a socket-driven cached read overtook Refresh all, its forced
    // scrape outcomes still matter. A newer family refresh owns that family's
    // status, so do not overwrite it with an older full request's result.
    if (refresh && mounted.current && explicitToken === explicitRequest.current) {
      setRefreshAllError(!result?.providers);
      const changedFamilies = new Set(activeFamilies.current);
      for (const [family, revision] of familyRevisions.current) {
        if (revision !== (startingFamilies.get(family) || 0)) changedFamilies.add(family);
      }
      if (result?.providers) setRefreshErrors((previous) => {
        const next = { ...previous };
        const localCards = result.providers.filter((item) => item.origin?.self !== false);
        const localFamilies = new Set(localCards.map((card) => card.family));
        for (const family of Object.keys(next)) {
          if (!changedFamilies.has(family) && !localFamilies.has(family) && (family !== 'imagegen' || result.imageQuotaComplete === true)) delete next[family];
        }
        for (const card of localCards.filter((item) => !changedFamilies.has(item.family))) {
          if (card.error) next[card.family] = { ...card, refreshAttemptAt: new Date().toISOString() };
          else if (resolvesQuotaRefresh(card)) delete next[card.family];
        }
        return next;
      });
    }
    if (token !== quotaRequest.current) return;
    fullInFlight.current = null;
    if (result?.providers) {
      if (!result.federationUnavailable) fullRevision.current += 1;
      // A family refresh can finish while this full read is in flight. Retain
      // its newer local card while still taking the full read's peer cards.
      const preserve = new Set(activeFamilies.current);
      for (const [family, revision] of familyRevisions.current) {
        if (revision !== (startingFamilies.get(family) || 0)) preserve.add(family);
      }
      if (result.imageQuotaComplete === false) preserve.add('imagegen');
      setQuotas((previous) => {
        if (!previous) return result.providers;
        const priorFamilies = new Set(previous.filter((card) => card.origin?.self !== false).map((card) => card.family));
        return [
          ...(result.federationUnavailable ? previous : result.providers).filter((card) => card.origin?.self === false),
          ...result.providers.filter((card) => card.origin?.self !== false && (!preserve.has(card.family) || !priorFamilies.has(card.family))),
          ...previous.filter((card) => card.origin?.self !== false && preserve.has(card.family)),
        ];
      });
      if (coverageToken === coverageRequest.current) setCoverage(result);
    } else {
      // Keep previously-loaded cards on a transient refresh failure.
      setError(true);
    }
    setLoading(false);
  }, [applyImageStatus]);

  useEffect(() => { mounted.current = true; load(); return () => { mounted.current = false; quotaRequest.current += 1; fullInFlight.current = null; }; }, [load]);

  // Refresh ONE provider card. The whole-section Refresh spawns every family's
  // scrape at once (10-20s each); this asks for the single card the user
  // clicked and swaps it in when the reading lands, leaving every other card's
  // reading — and its age — untouched. A failure toasts through the request
  // helper; the catch here only clears the spinner, it owns no error UI.
  const refreshFamily = useCallback(async (family) => {
    const startingFullRevision = fullRevision.current;
    const coverageToken = ++coverageRequest.current;
    const imageToken = family === 'imagegen' ? ++imageStatusRequest.current : null;
    const revision = (familyRevisions.current.get(family) || 0) + 1;
    familyRevisions.current.set(family, revision);
    activeFamilies.current.add(family);
    setRefreshingFamilies((prev) => new Set(prev).add(family));
    const result = await api.getProviderUsage({ refresh: true, family, scope: 'instances', silent: false }).catch(() => null);
    if (familyRevisions.current.get(family) !== revision) return;
    applyImageStatus(result, imageToken);
    activeFamilies.current.delete(family);
    // A full read may have started after this refresh began; advancing again
    // records that its response predates the refresh completion.
    familyRevisions.current.set(family, revision + 1);
    if (result?.providers) {
      // No card back for a family we asked for means it is no longer enabled
      // (its provider was turned off) — drop it rather than leave a reading
      // that can never refresh again. `prev` is always an array here: the
      // button that got us here only renders once quotas have loaded.
      const fullReadApplied = startingFullRevision !== fullRevision.current;
      const local = result.providers.find((card) => card.family === family && card.origin?.self !== false);
      const localUnavailable = family === 'imagegen' && (result.imageQuotaComplete === false || (!local && result.imageQuotaComplete !== true));
      setQuotas((prev) => mergeRefreshedFamily(prev, result.providers, family, { fullReadApplied, federationUnavailable: result.federationUnavailable, localUnavailable }));
      setRefreshErrors((previous) => {
        const next = { ...previous };
        if (local?.error) next[family] = { ...local, refreshAttemptAt: new Date().toISOString() };
        else if ((!local && !localUnavailable) || resolvesQuotaRefresh(local)) delete next[family];
        return next;
      });
      if (coverageToken === coverageRequest.current) setCoverage(result);
      // The older full response may contain an older peer slot even when it
      // preserves this local refresh. Supersede it with a fresh cached read.
      if (fullInFlight.current !== null) void load();
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
  }, [load, applyImageStatus]);

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

      <p className="text-xs text-gray-500">Account identity is unavailable, so readings from the same provider are assumed to share an account, including on API-billed instances. The latest available reading for each quota window is shown; allowances are not added. Refresh reads this instance only.</p>
      {coverage?.federationUnavailable && <p className="text-xs text-port-warning">Peer quota readings are unavailable.</p>}
      {coverage?.unreportedInstances?.length > 0 && <p className="text-xs text-port-warning">Quota reporting is unavailable from {coverage.unreportedInstances.join(', ')}.</p>}
      {imageQuotaComplete === false && <p className="text-xs text-port-warning">Image quota status on this instance is unavailable.</p>}
      {error && quotas && <p className="text-xs text-port-warning">Couldn&rsquo;t refresh quota readings; retained readings may be stale.</p>}
      {refreshAllError && !error && <p className="text-xs text-port-warning">Couldn&rsquo;t refresh all provider quotas; retained readings may be stale.</p>}

      {loading && !quotas && (
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

      {!loading && error && !quotas && (
        <div className="flex items-start gap-2 text-sm text-gray-400 py-2">
          <AlertTriangle size={16} className="text-port-warning mt-0.5 shrink-0" />
          <span>Couldn&rsquo;t read provider usage.</span>
        </div>
      )}

      {quotas && (
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
                  imageReadError={quota.family === 'imagegen' ? imageReadError : null}
                />
              ))}
            </div>
          ))}
          {quotas.length === 0 && (
            <div className="col-span-2 sm:col-span-1 text-gray-500 text-sm">No enabled providers report subscription usage.</div>
          )}
        </div>
      )}
    </div>
  );
}

// Approximate-rate marker: anything other than an exact model-id rate match.
const approxMark = (rateMatch) => (rateMatch === 'exact' || rateMatch === 'free' ? '' : '~');

// How a row's token counts were obtained. `measured` rows are summed from the
// provider CLI's own transcript; `estimate` rows are derived from prompt length
// and captured stdout and understate real usage substantially. Distinguishing
// them is the point of #3124 — a headline figure that mixes the two silently is
// what made the old report unusable.
const SOURCE_LABELS = {
  measured: { label: 'Measured', tone: 'success', title: 'Token counts read from the provider CLI’s own transcript' },
  mixed: { label: 'Part est.', tone: 'warning', title: 'Some counts measured from the provider transcript, some estimated' },
  estimate: { label: 'Estimated', tone: 'context', title: 'Estimated from prompt length and captured output — understates per-turn context and cache traffic' }
};

function SourcePill({ source, className = '' }) {
  const meta = SOURCE_LABELS[source] || SOURCE_LABELS.estimate;
  return (
    <Pill tone={meta.tone} size="xs" className={className} title={meta.title}>{meta.label}</Pill>
  );
}

function CostReportTable({ report }) {
  if (!report?.providers?.length) {
    return <div className="text-gray-500 text-sm py-4">No per-provider usage recorded in this period.</div>;
  }
  return (
    <>
      {/* Mobile view (< sm): Card list for easy mobile reading without horizontal scroll */}
      <div className="block sm:hidden space-y-3">
        {report.providers.map((provider) => (
          <div key={provider.rowKey || provider.id} className="bg-port-bg border border-port-border rounded-lg p-3 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-medium text-white text-sm truncate">{provider.name}</span>
                {provider.free && (
                  <Pill tone="success" size="xs" className="uppercase tracking-wide shrink-0">Local</Pill>
                )}
                {!provider.free && <SourcePill source={provider.source} className="shrink-0" />}
              </div>
              <span className="text-sm font-semibold text-port-success shrink-0" title={approxMark(provider.rateMatch) ? 'Approximate pricing' : undefined}>
                {provider.estimatedCost == null ? '—' : `${approxMark(provider.rateMatch)}${formatUsd(provider.estimatedCost)}`}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs text-gray-400 bg-port-card/50 p-2 rounded border border-port-border/50">
              <div>
                <span className="text-gray-500 block text-[10px]">Sessions</span>
                <span className="text-white font-medium">{formatNumber(provider.sessions)}</span>
              </div>
              <div>
                <span className="text-gray-500 block text-[10px]">Tokens (In / Out)</span>
                <span className="text-white font-medium">{formatNumber(provider.tokensIn)} / {formatNumber(provider.tokensOut)}</span>
              </div>
              <div>
                <span className="text-gray-500 block text-[10px]">Cache Read</span>
                <span className="text-gray-300">{formatNumber(provider.cacheReadTokens)}</span>
              </div>
              <div>
                <span className="text-gray-500 block text-[10px]">Cache Write</span>
                <span className="text-gray-300">{formatNumber(provider.cacheWriteTokens)}</span>
              </div>
            </div>

            {provider.models?.length > 0 && (
              <div className="space-y-1.5 pt-1.5 border-t border-port-border/40">
                <div className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Models</div>
                {provider.models.map((m) => (
                  <div key={m.model} className="bg-port-card/30 p-2 rounded text-xs space-y-1">
                    <div className="flex items-center justify-between font-mono text-gray-300 text-[11px]">
                      <span className="truncate pr-2" title={m.model}>{m.model}</span>
                      <span className="text-gray-400 shrink-0 font-sans font-medium">{m.estimatedCost == null ? '—' : `${approxMark(m.rateMatch)}${formatUsd(m.estimatedCost)}`}</span>
                    </div>
                    <div className="flex items-center justify-between text-[10px] text-gray-400">
                      <span>{formatNumber(m.sessions)} sess</span>
                      <span>{formatNumber(m.tokensIn)} in · {formatNumber(m.tokensOut)} out</span>
                      <span>Cache: {formatNumber((m.cacheReadTokens ?? 0) + (m.cacheWriteTokens ?? 0))}</span>
                    </div>
                    {usageExtras(m) && (
                      <div className="text-[10px] text-gray-500">{usageExtras(m)}</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}

        <div className="bg-port-bg border border-port-border rounded-lg p-3 flex items-center justify-between text-xs font-semibold text-white">
          <span>Total ({formatNumber(report.totals.sessions)} sessions)</span>
              <span className="text-port-success text-sm">{report.totals.costIncomplete ? '≥ ' : ''}{formatUsd(report.totals.estimatedCost)}</span>
        </div>
      </div>

      {/* Desktop view (>= sm): Table layout */}
      <div className="hidden sm:block overflow-x-auto">
        <table className="w-full text-sm min-w-[680px]" aria-label="Provider token usage and costs">
          <thead>
            <tr className="text-left text-xs text-gray-400 border-b border-port-border">
              <th scope="col" className="py-2 pr-2 font-medium">Provider / Model</th>
              <th scope="col" className="py-2 px-2 font-medium text-right">Sessions</th>
              <th scope="col" className="py-2 px-2 font-medium text-right">Tokens In</th>
              <th scope="col" className="py-2 px-2 font-medium text-right hidden md:table-cell">Cache Read</th>
              <th scope="col" className="py-2 px-2 font-medium text-right hidden md:table-cell">Cache Write</th>
              <th scope="col" className="py-2 px-2 font-medium text-right">Tokens Out</th>
              <th scope="col" className="py-2 pl-2 font-medium text-right">Est. API Cost</th>
            </tr>
          </thead>
          <tbody>
            {report.providers.map((provider) => (
              <ProviderCostRows key={provider.rowKey || provider.id} provider={provider} />
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-port-border font-semibold text-white">
              <td className="py-2 pr-2">Total</td>
              <td className="py-2 px-2 text-right">{formatNumber(report.totals.sessions)}</td>
              <td className="py-2 px-2 text-right">{formatNumber(report.totals.tokensIn)}</td>
              <td className="py-2 px-2 text-right hidden md:table-cell">{formatNumber(report.totals.cacheReadTokens)}</td>
              <td className="py-2 px-2 text-right hidden md:table-cell">{formatNumber(report.totals.cacheWriteTokens)}</td>
              <td className="py-2 px-2 text-right">{formatNumber(report.totals.tokensOut)}</td>
              <td className="py-2 pl-2 text-right text-port-success">{report.totals.costIncomplete ? '≥ ' : ''}{formatUsd(report.totals.estimatedCost)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}

// Cache token counts, with the hidden-on-mobile columns' values folded into a
// title so the numbers stay reachable when the columns collapse.
const cacheTitle = (row) =>
  `Cache read ${formatCount(row.cacheReadTokens, { fallback: '0' })} · cache write ${formatCount(row.cacheWriteTokens, { fallback: '0' })} tokens`;

// Imagine units and the 200k subset are not visible in the token columns.
function usageExtras(row) {
  if (!row) return '';
  const parts = [];
  if (row.images > 0) parts.push(`${formatNumber(row.images)} images`);
  if (row.inputImages > 0) parts.push(`${formatNumber(row.inputImages)} input images`);
  if (row.videoSeconds > 0) parts.push(`${formatNumber(row.videoSeconds)}s video`);
  const longTokens = (row.longTokensIn || 0) + (row.longCacheReadTokens || 0) + (row.longCacheWriteTokens || 0);
  if (longTokens > 0) parts.push(`${formatNumber(longTokens)} long-context`);
  return parts.join(' · ');
}

function ProviderCostRows({ provider }) {
  return (
    <>
      <tr className="border-t border-port-border text-white">
        <td className="py-2 pr-2">
          <span className="font-medium">{provider.name}</span>
          {provider.free && (
            <Pill tone="success" size="xs" className="ml-2 uppercase tracking-wide">Local — free</Pill>
          )}
          {!provider.free && <SourcePill source={provider.source} className="ml-2" />}
        </td>
        <td className="py-2 px-2 text-right" title={cacheTitle(provider)}>{formatNumber(provider.sessions)}</td>
        <td className="py-2 px-2 text-right" title={cacheTitle(provider)}>{formatNumber(provider.tokensIn)}</td>
        <td className="py-2 px-2 text-right hidden md:table-cell">{formatNumber(provider.cacheReadTokens)}</td>
        <td className="py-2 px-2 text-right hidden md:table-cell">{formatNumber(provider.cacheWriteTokens)}</td>
        <td className="py-2 px-2 text-right">{formatNumber(provider.tokensOut)}</td>
        <td
          className="py-2 pl-2 text-right"
          title={approxMark(provider.rateMatch) ? 'Approximate — provider or legacy usage uses fallback pricing' : undefined}
        >
          {provider.estimatedCost == null ? '—' : `${approxMark(provider.rateMatch)}${formatUsd(provider.estimatedCost)}`}
        </td>
      </tr>
      {provider.models.map((m) => (
        <tr key={m.model} className="text-gray-400">
          <td
            className="py-1.5 pr-2 pl-4 sm:pl-6 font-mono text-xs truncate max-w-[220px]"
            title={m.rateModel
              ? `Priced as ${m.rateModel} ($${m.inputPer1M}/$${m.outputPer1M} per 1M in/out; $${m.cacheReadPer1M}/$${m.cacheWritePer1M} per 1M cache read/write)`
              : undefined}
          >
            {m.model}
            {usageExtras(m) && (
              <div className="font-sans text-[10px] text-gray-500 truncate">{usageExtras(m)}</div>
            )}
          </td>
          <td className="py-1.5 px-2 text-right text-xs">{formatNumber(m.sessions)}</td>
          <td className="py-1.5 px-2 text-right text-xs" title={cacheTitle(m)}>{formatNumber(m.tokensIn)}</td>
          <td className="py-1.5 px-2 text-right text-xs hidden md:table-cell">{formatNumber(m.cacheReadTokens)}</td>
          <td className="py-1.5 px-2 text-right text-xs hidden md:table-cell">{formatNumber(m.cacheWriteTokens)}</td>
          <td className="py-1.5 px-2 text-right text-xs">{formatNumber(m.tokensOut)}</td>
          <td className="py-1.5 pl-2 text-right text-xs" title={approxMark(m.rateMatch) ? 'Approximate — no exact published rate for this model id' : undefined}>
            {m.estimatedCost == null ? '—' : `${approxMark(m.rateMatch)}${formatUsd(m.estimatedCost)}`}
          </td>
        </tr>
      ))}
    </>
  );
}

// Time-filter pills + custom range, driven by URL search params so every
// report view is shareable/bookmarkable (linkable-routes convention).
// A native date input reports "" while its mm/dd/yyyy segments are only
// partly typed, so binding it straight to the URL param wiped the field
// mid-keystroke. Hold the draft locally and commit only complete dates (or an
// explicit clear); re-sync when the committed value changes underneath.
function RangeDateInput({ id, label, value, onCommit }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  const handleChange = (e) => {
    const next = e.target.value;
    setDraft(next);
    if (next === '' && e.target.validity.badInput) return;
    // Typing a year passes through 0002, 0020, 0202 — valid dates, not intent.
    if (next !== '' && Number(next.slice(0, 4)) < 1900) return;
    if (next !== value) onCommit(next);
  };
  return (
    <input
      id={id}
      aria-label={label}
      type="date"
      value={draft}
      onChange={handleChange}
      className="bg-transparent text-xs text-white outline-none [color-scheme:dark]"
    />
  );
}

function CostReportFilters({ period, from, to, isCustom, onPeriod, onRange }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {USAGE_PERIOD_OPTIONS.map((opt) => (
        <button
          key={opt.id}
          onClick={() => onPeriod(opt.id)}
          className={`px-3 py-1 rounded-full text-xs sm:text-sm border ${!isCustom && period === opt.id
            ? 'bg-port-accent/20 border-port-accent text-white'
            : 'border-port-border text-gray-400 hover:text-white'}`}
        >
          {opt.label}
        </button>
      ))}
      <div className={`flex flex-wrap items-center gap-1.5 rounded-xl border px-2 py-0.5 ${isCustom ? 'border-port-accent bg-port-accent/10' : 'border-port-border'}`}>
        <div className="flex items-center gap-1.5">
          <label htmlFor="usage-from" className="text-xs text-gray-400">From</label>
          <RangeDateInput id="usage-from" label="From date" value={from} onCommit={(v) => onRange(v, to)} />
        </div>
        <div className="flex items-center gap-1.5">
          <label htmlFor="usage-to" className="text-xs text-gray-400">To</label>
          <RangeDateInput id="usage-to" label="To date" value={to} onCommit={(v) => onRange(from, v)} />
        </div>
      </div>
    </div>
  );
}

// Derive top providers for the active period (or fallback to usage.topProviders)
function combineSummaryRows(rows, keyOf) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { ...row, estimatedCost: row.rawEstimatedCost ?? row.estimatedCost ?? 0, costIncomplete: row.estimatedCost == null });
      continue;
    }
    for (const field of ['sessions', 'tokens', 'tokensIn', 'tokensOut', 'cacheReadTokens', 'cacheWriteTokens']) existing[field] = (existing[field] || 0) + (row[field] || 0);
    existing.estimatedCost += row.rawEstimatedCost ?? row.estimatedCost ?? 0;
    existing.costIncomplete ||= row.estimatedCost == null;
    if (existing.free !== row.free) existing.free = null;
    if (existing.source !== row.source) existing.source = 'mixed';
  }
  return [...groups.values()].map((row) => ({ ...row, estimatedCost: Math.round(row.estimatedCost * 100) / 100 }));
}

function getPeriodTopProviders(usage) {
  if (usage?.report?.providers) {
    const totalTokens = usage.report.providers.reduce(
      (sum, p) => sum + (p.tokensIn || 0) + (p.tokensOut || 0) + (p.cacheReadTokens || 0) + (p.cacheWriteTokens || 0),
      0
    ) || usage.report.providers.reduce((sum, p) => sum + (p.sessions || 0), 0) || 1;

    const rows = usage.report.providers
      .map((p) => {
        const tokens = (p.tokensIn || 0) + (p.tokensOut || 0) + (p.cacheReadTokens || 0) + (p.cacheWriteTokens || 0);
        return {
          id: p.id,
          name: p.name,
          sessions: p.sessions || 0,
          tokens: tokens || (p.tokens ?? 0),
          tokensIn: p.tokensIn,
          tokensOut: p.tokensOut,
          cacheReadTokens: p.cacheReadTokens,
          cacheWriteTokens: p.cacheWriteTokens,
          estimatedCost: p.estimatedCost,
          rawEstimatedCost: p.rawEstimatedCost,
          free: p.free,
          source: p.source,
          rateMatch: p.rateMatch,
          percent: Math.min(100, Math.round(((tokens || p.sessions || 0) / totalTokens) * 100))
        };
      });
    return combineSummaryRows(rows, (row) => row.id)
      .map((row) => ({ ...row, percent: Math.min(100, Math.round(((row.tokens || row.sessions || 0) / totalTokens) * 100)) }))
      .sort((a, b) => b.tokens - a.tokens || b.sessions - a.sessions)
      .slice(0, 5);
  }

  const totalTokens = usage?.topProviders?.reduce((sum, p) => sum + (p.tokens || 0), 0)
    || usage?.topProviders?.reduce((sum, p) => sum + (p.sessions || 0), 0) || 1;

  return (usage?.topProviders || []).map((p) => ({
    id: p.id || p.name,
    name: p.name,
    sessions: p.sessions || 0,
    tokens: p.tokens || 0,
    percent: Math.min(100, Math.round(((p.tokens || p.sessions || 0) / totalTokens) * 100))
  }));
}

// Derive top models for the active period (or fallback to usage.topModels)
function getPeriodTopModels(usage) {
  if (usage?.report?.providers) {
    const allModels = [];
    for (const p of usage.report.providers) {
      for (const m of (p.models || [])) {
        const tokens = (m.tokensIn || 0) + (m.tokensOut || 0) + (m.cacheReadTokens || 0) + (m.cacheWriteTokens || 0);
        allModels.push({
          model: m.model,
          providerName: p.name,
          sessions: m.sessions || 0,
          tokens: tokens || (m.tokens ?? 0),
          tokensIn: m.tokensIn,
          tokensOut: m.tokensOut,
          cacheReadTokens: m.cacheReadTokens,
          cacheWriteTokens: m.cacheWriteTokens,
          estimatedCost: m.estimatedCost,
          rawEstimatedCost: m.rawEstimatedCost,
          providerId: p.id,
          rateMatch: m.rateMatch
        });
      }
    }
    if (allModels.length > 0) {
      const totalTokens = allModels.reduce((sum, m) => sum + m.tokens, 0)
        || allModels.reduce((sum, m) => sum + m.sessions, 0) || 1;

      return combineSummaryRows(allModels, (row) => `${row.providerId}\u0000${row.model}`)
        .map((m) => ({
          ...m,
          percent: Math.min(100, Math.round(((m.tokens || m.sessions || 0) / totalTokens) * 100))
        }))
        .sort((a, b) => b.tokens - a.tokens || b.sessions - a.sessions)
        .slice(0, 5);
    }
    return [];
  }

  const totalTokens = usage?.topModels?.reduce((sum, m) => sum + (m.tokens || 0), 0)
    || usage?.topModels?.reduce((sum, m) => sum + (m.sessions || 0), 0) || 1;

  return (usage?.topModels || []).map((m) => ({
    model: m.model,
    sessions: m.sessions || 0,
    tokens: m.tokens || 0,
    percent: Math.min(100, Math.round(((m.tokens || m.sessions || 0) / totalTokens) * 100))
  }));
}

function InternalUsageMetrics() {
  const [fleetRevision, setFleetRevision] = useState(0);
  const [searchParams, setSearchParams] = useSearchParams();
  const period = searchParams.get('period') || DEFAULT_USAGE_PERIOD;
  const from = searchParams.get('from') || '';
  const to = searchParams.get('to') || '';
  const isCustom = Boolean(from || to);

  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState(false);
  const [loadedRange, setLoadedRange] = useState(null);
  const { data: backfill, updateData: setBackfill, refetch: refreshBackfill } = useSocketResource(
    () => api.getUsageBackfillStatus({ silent: true }),
    { events: BACKFILL_EVENTS },
  );

  // One fetch for every trigger — the range effect, the backfill-complete
  // refetch, and a subscription-price save (which re-derives the savings block
  // server-side). It resolves once the new payload is applied, so a caller can
  // keep its button busy until the screen actually reflects the change.
  const requestRef = useRef(0);
  const fetchUsage = useCallback(async () => {
    const token = ++requestRef.current;
    const params = isCustom ? { from, to } : { period };
    const rangeLabel = isCustom
      ? `${from || 'Beginning'} to ${to || 'No end'}`
      : (USAGE_PERIOD_OPTIONS.find((option) => option.id === period)?.label || period);
    setLoading(true);
    setReadError(false);
    const data = await api.getUsage(params, { silent: true }).catch(() => null);
    if (token === requestRef.current) {
      if (data) {
        setUsage(data);
        setLoadedRange(rangeLabel);
      }
      setReadError(!data);
      setLoading(false);
    }
    return data;
  }, [period, from, to, isCustom]);

  useEffect(() => {
    fetchUsage();
    return () => { requestRef.current += 1; };
  }, [fetchUsage]);

  useSocketResource(fetchUsage, { events: IMAGE_USAGE_EVENTS, immediate: false });
  useSocketResource(() => { setFleetRevision((value) => value + 1); return fetchUsage(); },
    { namespace: 'instances', events: FLEET_SYNC_EVENTS, matchesEvent: isUsageSync, immediate: false });

  const [startBackfill, startingBackfill] = useAsyncAction(async () => {
    const status = await api.startUsageBackfill({ silent: true });
    setBackfill(status);
    // A fast worker can finish before the POST response arrives. Reconcile
    // once so that response cannot overwrite an already-observed completion.
    if (status?.status === 'running') await refreshBackfill();
  }, { errorMessage: 'Failed to start historical usage reconciliation' });

  useEffect(() => {
    if (backfill?.status === 'complete') fetchUsage();
  }, [backfill, fetchUsage]);


  const setPeriod = (id) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('from');
      next.delete('to');
      if (id === DEFAULT_USAGE_PERIOD) next.delete('period'); else next.set('period', id);
      return next;
    }, { replace: true });
  };

  const setRange = (nextFrom, nextTo) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('period');
      if (nextFrom) next.set('from', nextFrom); else next.delete('from');
      if (nextTo) next.set('to', nextTo); else next.delete('to');
      return next;
    }, { replace: true });
  };

  const reportControls = (
    <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4 space-y-3">
      <CostReportFilters period={period} from={from} to={to} isCustom={isCustom} onPeriod={setPeriod} onRange={setRange} />
      {usage && <p className="text-sm text-gray-400">Showing usage for {loadedRange}.{(loading || readError) && ' Retained figures may be stale.'}</p>}
      {loading && <p className="text-sm text-gray-400" role="status">Loading selected usage range…</p>}
      {readError && (
        <div role="alert" className="text-sm text-port-warning flex flex-wrap items-center gap-3">
          <span>Usage unavailable for the selected range.</span>
          <button type="button" onClick={fetchUsage} className="min-h-11 px-3 rounded-lg border border-port-border hover:border-port-accent">Retry usage</button>
        </div>
      )}
    </div>
  );

  if (!usage) {
    return (
      <div className="space-y-6">
        <h2 className="text-lg font-semibold text-white">PortOS AI Usage</h2>
        {reportControls}
        {loading && <PageSkeleton label="Loading usage data" titleWidthClass="w-44" showAction={false} layout="grid" gridColsClass="grid-cols-2 sm:grid-cols-4" cards={4} />}
      </div>
    );
  }

  const maxActivity = Math.max(1, ...(usage.activity?.map(d => d.sessions) || []));
  const report = usage.report;

  const topProvidersList = getPeriodTopProviders(usage);
  const topModelsList = getPeriodTopModels(usage);

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-white">PortOS AI Usage</h2>
      {/* Trailing 30 days across every instance — independent of the range below. */}
      <RollingCostCard coverage={usage.coverage} fleetRevision={fleetRevision} />
      <MonthlyUsageCard history={usage.monthlyHistory} series={usage.monthlySeries} instanceCount={usage.monthlyInstanceCount} rangeTooWide={usage.monthlyRangeTooWide} coverage={usage.coverage} />
      {reportControls}
      {usage.coverage && (
        <div className="text-xs text-gray-400 space-y-1" role="status">
          <p>Usage from {formatCount(usage.coverage.instanceCount)} reported instance{usage.coverage.instanceCount === 1 ? '' : 's'}; peer data reflects the last sync.</p>
          {usage.coverage.instanceCount > 1 && <p>Each instance snapshot is counted once. Runs recorded independently on multiple machines cannot be deduplicated from the available aggregates.</p>}
          <p>Cost classifications use each instance&rsquo;s current provider configuration; historical configuration changes are not available.</p>
          {usage.coverage.pricingIncomplete && <p className="text-port-warning">Some provider classifications are unavailable. API cost and savings include only classified usage and are incomplete.</p>}
          {usage.coverage.classificationUnreported?.length > 0 && <p className="text-port-warning">Provider classifications have not been reported by {usage.coverage.classificationUnreported.join(', ')}.</p>}
          {usage.coverage.missingInstances?.length > 0 && <p className="text-port-warning">No usage snapshot from {usage.coverage.missingInstances.join(', ')}. Totals are incomplete.</p>}
          {usage.coverage.notSyncingInstances?.length > 0 && <p className="text-port-warning">Usage sync is disabled for {usage.coverage.notSyncingInstances.join(', ')}. Their saved figures may be stale.</p>}
          {usage.coverage.transcriptUnreported?.length > 0 && <p className="text-port-warning">Claude transcript history has not been reported by {usage.coverage.transcriptUnreported.join(', ')}; the monthly chart may be incomplete.</p>}
          {usage.coverage.incompleteMonths?.length > 0 && <p className="text-port-warning">Older usage is available only by month. Partial months {usage.coverage.incompleteMonths.join(', ')} are excluded; totals are incomplete.</p>}
        </div>
      )}

      <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium text-white">
            <DatabaseZap size={16} className="text-port-accent" />
            Reconcile historical usage
          </div>
          <p className="text-xs text-gray-500 mt-1">
            Re-read saved transcripts, Grok sessions, and Antigravity media to replace older estimates and record media and long-context charges. This changes recorded history but makes no provider calls.
          </p>
          {backfill?.status === 'running' && (
            <p className="text-xs text-port-accent mt-1" role="status">
              Processing {backfill.processed || 0} of {backfill.total || 0} runs…
            </p>
          )}
          {backfill?.status === 'complete' && (
            <p className="text-xs text-port-success mt-1" role="status">
              Corrected {backfill.corrected || 0} run{backfill.corrected === 1 ? '' : 's'}.
            </p>
          )}
          {backfill?.grok && (backfill.status === 'complete' || backfill.status === 'error') && (
            <p className="text-xs text-port-success mt-1" role="status">{grokRepairLine(backfill.grok)}</p>
          )}
          {backfill?.agy && (backfill.status === 'complete' || backfill.status === 'error') && (
            <p className="text-xs text-port-success mt-1" role="status">{agyRepairLine(backfill.agy)}</p>
          )}
          {backfill?.status === 'error' && (
            <p className="text-xs text-port-error mt-1" role="alert">{backfill.error}</p>
          )}
        </div>
        <button
          type="button"
          onClick={startBackfill}
          disabled={startingBackfill || backfill?.status === 'running'}
          className="shrink-0 inline-flex items-center justify-center gap-2 rounded-lg border border-port-border px-3 py-2 text-sm text-white hover:border-port-accent disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {(startingBackfill || backfill?.status === 'running') ? <BrailleSpinner /> : <DatabaseZap size={15} />}
          {backfill?.status === 'running' ? 'Reconciling…' : 'Reconcile now'}
        </button>
      </div>

      {usage.imageRenders && (
        <section className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4 space-y-2" aria-label="Codex image usage">
          <h3 className="text-sm font-medium text-white">Codex image usage</h3>
          {usage.imageRenders.error ? (
            <p className="text-sm text-gray-400" role="status">Image render usage is unavailable. Text usage remains available.</p>
          ) : (
            <>
          {usage.imageRenders.incomplete && <p className="text-xs text-port-warning" role="status">Partial: some instances did not report complete image receipts or reported conflicting identities.</p>}
          <p className="text-sm text-gray-300">
            {formatCount(usage.imageRenders.codexSessions)} Codex sessions · {formatCount(usage.imageRenders.savedOutputs)} saved outputs in this period
          </p>
          <p className="text-xs text-gray-400">
            Image tokens, image cost and subscription allowance attribution: unknown.
            Any driver tokens already captured by text accounting stay in the text report. Image costs are excluded from the API estimate.
            Saved outputs show observed activity; they do not measure every image-tool call or failed attempt.
            Mirrored outputs are counted once by their saved identity.
            Sessions and driver totals are attributed to the day of the first saved output; outputs are counted on their own day.
          </p>
          <p className="text-xs text-gray-400">
            {usage.imageRenders.driverTokens
              ? `${formatCount(usage.imageRenders.driverTokens.reportedTotal)} reported driver tokens across ${formatCount(usage.imageRenders.driverTokens.sessionsMeasured)} sessions; no input/output split or image attribution.`
              : 'Driver tokens: unknown.'}
            {usage.imageRenders.driverTokens && ` Driver tokens are unknown for ${formatCount(usage.imageRenders.driverSessionsUnknown)} other render groups.`}
          </p>
          {usage.imageRenders.jobIdentityGroups > 0 && (
            <p className="text-xs text-gray-400">{formatCount(usage.imageRenders.jobIdentityGroups)} additional render groups use saved job IDs; their Codex session IDs are unavailable.</p>
          )}
            </>
          )}
        </section>
      )}

      {/* Summary Stats for the selected report window */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
        <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4 text-center">
          <div className="text-xl sm:text-2xl font-bold text-white">{formatNumber(report?.totals?.sessions)}</div>
          <div className="text-xs sm:text-sm text-gray-400">Sessions</div>
        </div>
        <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4 text-center">
          <div className="text-xl sm:text-2xl font-bold text-white">{formatNumber(report?.totals?.messages)}</div>
          <div className="text-xs sm:text-sm text-gray-400">Messages</div>
        </div>
        <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4 text-center">
          <div className="text-xl sm:text-2xl font-bold text-white">{formatNumber((report?.totals?.tokensIn ?? 0) + (report?.totals?.tokensOut ?? 0) + (report?.totals?.cacheReadTokens ?? 0) + (report?.totals?.cacheWriteTokens ?? 0))}</div>
          <div className="text-xs sm:text-sm text-gray-400">Tokens</div>
        </div>
      </div>

      {/* Cost report — range-filtered per-provider/per-model breakdown */}
      <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div>
            <h3 className="text-sm font-medium text-gray-400">Est. API Cost Report</h3>
            {report?.breakdownSince && (
              <p className="text-[10px] sm:text-xs text-port-warning">
                Provider/model detail starts {report.breakdownSince}; earlier usage is grouped as legacy.
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {report?.totals?.source && <SourcePill source={report.totals.source} />}
            <span className="text-xl font-bold text-port-success">{report?.totals?.costIncomplete ? '≥ ' : ''}{formatUsd(report?.totals?.estimatedCost)}</span>
          </div>
        </div>
        <CostReportTable report={report} />
        <p className="text-[10px] sm:text-xs text-gray-500">
          Informational estimate of what this usage would have cost under API billing (PortOS runs on subscriptions).
          {' '}<span className="text-gray-400">Measured</span> rows are the provider CLI&rsquo;s own per-message counts, read from its local
          transcript — full per-turn input, output, and prompt-cache reads/writes, each priced at its own rate.
          {' '}Grok rows are measured the same way once a turn completes; a run killed mid-turn falls back to its chat history.
          {' '}<span className="text-gray-400">Estimated</span> rows are runs with no token counts to read: Antigravity writes a
          session transcript but no token fields, so its rows are sized from that transcript&rsquo;s text, and a run with no session
          file at all (local models) is approximated from the initial prompt only with no cache traffic counted — those rows
          understate real usage substantially.
          {' '}OpenCode-backed runs (including zen) contribute the output tokens from the run&rsquo;s own event stream and stay
          estimated on input. Rates are as of {report?.pricingAsOf || 'the last update'} and exclude batch and long-context tiers.
          {' '}Rows marked ~ use an approximated rate.
        </p>
      </div>

      {/* Free-tier counterpart of the cost report above: ledger-tracked queries
          and tokens on quotas with no usage API (e.g. opencode zen), plus the
          observed limit blocks that stand in for a quota meter. */}
      <FreeTierUsageCard freeTier={usage.freeTier} />

      {/* Claude Code tokens per model (all instances) for the same window. */}
      <ClaudeCodeModelTokensCard period={period} from={from} to={to} isCustom={isCustom} onRefreshed={fetchUsage} transcriptUpdatedAt={usage.transcriptUpdatedAt} fleetRevision={fleetRevision} />

      {/* Same window, split by machine — renders only once a peer's usage has
          synced, so a single-machine install sees no change. */}
      <FleetUsageCard fleet={usage.fleet} onSaved={fetchUsage} />

      {/* Directly under the API estimate it is derived from: the estimate is the
          opportunity cost, this is what the quota plans actually cost to avoid it. */}
      <SubscriptionSavingsCard savings={usage.subscriptionSavings} onSaved={fetchUsage} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6">
        {/* Selected-period activity */}
        <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4">
          <h3 className="text-sm font-medium text-gray-400 mb-3 sm:mb-4">Sessions in selected period</h3>
          <div className="flex items-end gap-1 sm:gap-2 h-32 sm:h-40">
            {usage.activity?.map((day) => (
              <div key={day.date} title={`${day.date}: ${formatCount(day.sessions)} sessions`} className="flex-1 min-w-0 h-full flex flex-col items-center">
                {/* percent heights need a definite-height parent, so the bar sits in a flex-1 slot */}
                <div className="flex-1 w-full flex items-end min-h-0">
                  <div
                    className="w-full bg-port-accent/60 rounded-t"
                    style={{ height: `${(day.sessions / maxActivity) * 100}%`, minHeight: day.sessions > 0 ? 4 : 0 }}
                  />
                </div>
                {usage.activity.length <= 12 && <div className="text-[10px] sm:text-xs text-gray-500 mt-1 sm:mt-2">{day.label}</div>}
                {usage.activity.length <= 12 && <div className="text-[10px] sm:text-xs text-gray-400">{formatCount(day.sessions)}</div>}
              </div>
            ))}
            {usage.activity?.length === 0 && <p className="text-sm text-gray-500">No sessions in this period.</p>}
          </div>
          {usage.activity?.length > 12 && (
            <details className="mt-2 text-xs text-gray-400">
              <summary className="cursor-pointer">View session counts by date</summary>
              <ul className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-1">
                {usage.activity.map((day) => <li key={day.date}>{day.date}: {formatCount(day.sessions)}</li>)}
              </ul>
            </details>
          )}
        </div>

        {/* Hourly Distribution */}
        <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4">
          <h3 className="text-sm font-medium text-gray-400 mb-3 sm:mb-4">Hourly Distribution</h3>
          {usage.hourlyActivity ? <>
          <div className="flex items-end gap-0.5 h-24 sm:h-32">
            {(() => {
              const maxHour = Math.max(1, ...(usage.hourlyActivity || []));
              return usage.hourlyActivity?.map((count, hour) => (
                <div key={hour} className="flex-1 h-full flex items-end">
                  <div
                    className="w-full bg-port-accent/40 rounded-t"
                    style={{ height: `${(count / maxHour) * 100}%`, minHeight: count > 0 ? 2 : 0 }}
                    title={`${hour}:00 - ${count} sessions`}
                  />
                </div>
              ));
            })()}
          </div>
          <div className="flex justify-between text-[10px] sm:text-xs text-gray-500 mt-1 sm:mt-2">
            <span>12am</span>
            <span>6am</span>
            <span>12pm</span>
            <span>6pm</span>
            <span>12am</span>
          </div>
          <p className="text-xs text-gray-500 mt-1">Sessions in this period across available instances, by each instance&rsquo;s local clock.</p>
          {usage.coverage?.hourlyIncomplete && <p className="text-xs text-port-warning mt-1">Partial: older sessions or unavailable instances do not provide hourly detail.</p>}
          </> : <p className="text-sm text-gray-500">Hourly data is unavailable for this period.</p>}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6">
        {/* Top Providers */}
        <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4">
          <h3 className="text-sm font-medium text-gray-400 mb-2 sm:mb-3 flex items-center justify-between">
            <span>Top Providers</span>
            <span className="text-xs text-gray-500 font-normal">By usage volume</span>
          </h3>
          <div className="space-y-3">
            {topProvidersList.map((provider, i) => (
              <div key={i} className="py-1.5 border-b border-port-border last:border-0 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-white text-sm sm:text-base font-medium truncate">{provider.name}</span>
                    {provider.free && (
                      <Pill tone="success" size="xs" className="uppercase tracking-wide shrink-0">Local</Pill>
                    )}
                    {!provider.free && provider.source && (
                      <SourcePill source={provider.source} className="shrink-0" />
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0 text-xs">
                    {provider.estimatedCost != null && provider.estimatedCost > 0 && (
                      <span className="text-port-success font-semibold">{provider.costIncomplete ? '≥ ' : ''}{formatUsd(provider.estimatedCost)}</span>
                    )}
                    <span className="text-gray-400 bg-port-bg border border-port-border px-1.5 py-0.5 rounded text-[10px] sm:text-xs font-mono">
                      {provider.percent}%
                    </span>
                  </div>
                </div>

                {/* Visual Usage Bar */}
                <div className="h-1.5 rounded-full bg-port-bg overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-port-accent to-blue-400 transition-all duration-300"
                    style={{ width: `${Math.max(2, provider.percent)}%` }}
                  />
                </div>

                {/* Detailed Breakdown stats */}
                <div className="flex items-center justify-between text-xs text-gray-400">
                  <span>{formatCount(provider.sessions)} session{provider.sessions === 1 ? '' : 's'}</span>
                  <div className="flex items-center gap-1 sm:gap-2">
                    <span>{formatNumber(provider.tokens)} tokens</span>
                    {provider.tokensIn != null && provider.tokensOut != null && (
                      <span className="text-[10px] text-gray-500 hidden sm:inline">
                        ({formatNumber(provider.tokensIn)} fresh in / {formatNumber(provider.tokensOut)} out / {formatNumber((provider.cacheReadTokens || 0) + (provider.cacheWriteTokens || 0))} cache)
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
            {topProvidersList.length === 0 && (
              <div className="text-gray-500 text-sm">No provider data</div>
            )}
          </div>
        </div>

        {/* Top Models */}
        <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4">
          <h3 className="text-sm font-medium text-gray-400 mb-2 sm:mb-3 flex items-center justify-between">
            <span>Top Models</span>
            <span className="text-xs text-gray-500 font-normal">By token output & volume</span>
          </h3>
          <div className="space-y-3">
            {topModelsList.map((model, i) => (
              <div key={i} className="py-1.5 border-b border-port-border last:border-0 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-white font-mono text-xs sm:text-sm truncate">{model.model}</span>
                    {model.providerName && (
                      <span className="text-[10px] text-gray-500 truncate hidden sm:inline">({model.providerName})</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0 text-xs">
                    {model.estimatedCost != null && model.estimatedCost > 0 && (
                      <span className="text-port-success font-semibold">{model.costIncomplete ? '≥ ' : ''}{formatUsd(model.estimatedCost)}</span>
                    )}
                    <span className="text-gray-400 bg-port-bg border border-port-border px-1.5 py-0.5 rounded text-[10px] sm:text-xs font-mono">
                      {model.percent}%
                    </span>
                  </div>
                </div>

                {/* Visual Usage Bar */}
                <div className="h-1.5 rounded-full bg-port-bg overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-teal-400 transition-all duration-300"
                    style={{ width: `${Math.max(2, model.percent)}%` }}
                  />
                </div>

                {/* Detailed Breakdown stats */}
                <div className="flex items-center justify-between text-xs text-gray-400">
                  <span>{formatCount(model.sessions)} session{model.sessions === 1 ? '' : 's'}</span>
                  <div className="flex items-center gap-1 sm:gap-2">
                    <span>{formatNumber(model.tokens)} tokens</span>
                    {model.tokensIn != null && model.tokensOut != null && (
                      <span className="text-[10px] text-gray-500 hidden sm:inline">
                        ({formatNumber(model.tokensIn)} fresh in / {formatNumber(model.tokensOut)} out / {formatNumber((model.cacheReadTokens || 0) + (model.cacheWriteTokens || 0))} cache)
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
            {topModelsList.length === 0 && (
              <div className="text-gray-500 text-sm">No model data</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function UsagePage() {
  return (
    <PageLayout header={<PageHeader icon={BarChart3} title="Subscription Usage" />} navigation={<ModelsTabsHeader activeTab="usage" />}>
      <div className="space-y-6">
        <ProviderQuotaSection />
        <InternalUsageMetrics />
      </div>
    </PageLayout>
  );
}

export default UsagePage;
