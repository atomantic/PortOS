import PageHeader from '../components/PageHeader';
import PageLayout from '../components/PageLayout';
import { useCallback, useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router';
import { DatabaseZap, BarChart3 } from 'lucide-react';
import { getUsageBackfillStatus, getUsage, startUsageBackfill } from '../services/apiSystem.js';
import BrailleSpinner from '../components/BrailleSpinner';
import PageSkeleton from '../components/ui/PageSkeleton';
import Pill from '../components/ui/Pill';
import { formatCompactCountOrDash as formatNumber, formatCount } from '../utils/formatters';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { useSocketResource } from '../hooks/useSocketResource';
import SubscriptionSavingsCard from '../components/usage/SubscriptionSavingsCard';
import ClaudeCodeModelTokensCard from '../components/usage/ClaudeCodeModelTokensCard';
import FleetUsageCard from '../components/usage/FleetUsageCard';
import MonthlyUsageCard from '../components/usage/MonthlyUsageCard';
import RollingCostCard from '../components/usage/RollingCostCard';
import FreeTierUsageCard from '../components/usage/FreeTierUsageCard';
import UsageRetentionTips from '../components/usage/UsageRetentionTips';
import ProviderQuotaSection, { FLEET_BILLING_EVENTS, FLEET_SYNC_EVENTS, isUsageSync } from '../components/usage/ProviderQuotaSection';
import { CostReportCard, CostReportFilters, NativeSourcesNote, SourcePill, getPeriodTopModels, getPeriodTopProviders } from '../components/usage/CostReportSection';
import UsageVolumeLeaderboardCard from '../components/usage/UsageVolumeLeaderboardCard';
import ModelsTabsHeader from '../components/models/ModelsTabsHeader';
import { USAGE_PERIOD_OPTIONS, DEFAULT_USAGE_PERIOD } from '../lib/usagePeriods';

export { arrangeQuotaCells } from '../components/usage/ProviderQuotaSection';

const BACKFILL_EVENTS = ['usage-backfill:updated'];
const IMAGE_USAGE_EVENTS = ['image-gen:completed'];
// A provider app's own usage history changed (Claude Code, Codex, Grok, Antigravity).
const NATIVE_HISTORY_EVENTS = ['usage:native-history-updated'];

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
  if (grok.fast) parts.push(`${formatCount(grok.fast)} fast turn${grok.fast === 1 ? '' : 's'}`);
  if (grok.images) parts.push(`${formatCount(grok.images)} image${grok.images === 1 ? '' : 's'}`);
  if (grok.videos) parts.push(`${formatCount(grok.videos)} video${grok.videos === 1 ? '' : 's'}`);
  const added = parts.length ? `Added ${joinAnd(parts)}.` : 'Grok usage was already recorded.';
  return grok.note ? `${added} ${grok.note}` : added;
}

/** What Reconcile now added for Codex speed. Absent until that job finishes. */
function codexRepairLine(codex) {
  if (!codex) return '';
  const added = codex.sessions
    ? `Added fast-mode premiums for ${formatCount(codex.sessions)} Codex session${codex.sessions === 1 ? '' : 's'}.`
    : 'Codex speed premiums were already recorded.';
  return codex.note ? `${added} ${codex.note}` : added;
}

/** What Reconcile now added to the Antigravity ledger. Absent until that job finishes. */
function agyRepairLine(agy) {
  if (!agy) return '';
  const parts = [];
  if (agy.images) parts.push(`${formatCount(agy.images)} image${agy.images === 1 ? '' : 's'}`);
  const added = parts.length ? `Added ${joinAnd(parts)}.` : 'Antigravity usage was already recorded.';
  return agy.note ? `${added} ${agy.note}` : added;
}

function InternalUsageMetrics({ onBillingSaved }) {
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
    () => getUsageBackfillStatus({ silent: true }),
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
    const data = await getUsage(params, { silent: true }).catch(() => null);
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
  useSocketResource(fetchUsage, { events: FLEET_BILLING_EVENTS, immediate: false });
  useSocketResource(() => { setFleetRevision((value) => value + 1); return fetchUsage(); }, { events: NATIVE_HISTORY_EVENTS, immediate: false });
  useSocketResource(() => { setFleetRevision((value) => value + 1); return fetchUsage(); },
    { namespace: 'instances', events: FLEET_SYNC_EVENTS, matchesEvent: isUsageSync, immediate: false });

  const [startBackfill, startingBackfill] = useAsyncAction(async () => {
    const status = await startUsageBackfill({ silent: true });
    setBackfill(status);
    // A fast worker can finish before the POST response arrives. Reconcile
    // once so that response cannot overwrite an already-observed completion.
    if (status?.status === 'running') await refreshBackfill();
  }, { errorMessage: 'Failed to start historical usage reconciliation' });

  useEffect(() => {
    if ((backfill?.status === 'complete' || backfill?.status === 'error')) {
      setFleetRevision((value) => value + 1);
      fetchUsage();
    }
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
      <RollingCostCard fleetRevision={fleetRevision} onReconcile={startBackfill} reconciling={startingBackfill || backfill?.status === 'running'} />
      <MonthlyUsageCard history={usage.monthlyHistory} series={usage.monthlySeries} instanceCount={usage.monthlyInstanceCount} rangeTooWide={usage.monthlyRangeTooWide} coverage={usage.coverage} onReconcile={startBackfill} reconciling={startingBackfill || backfill?.status === 'running'} />
      {reportControls}
      {usage.coverage && (
        <div className="text-xs text-gray-400 space-y-1" role="status">
          <p>Usage from {formatCount(usage.coverage.instanceCount)} reported instance{usage.coverage.instanceCount === 1 ? '' : 's'}; peer data reflects the last sync.</p>
          {usage.coverage.instanceCount > 1 && <p>Each instance snapshot is counted once. Runs recorded independently on multiple machines cannot be deduplicated from the available aggregates.</p>}
          <NativeSourcesNote sources={usage.nativeSources} />
          <p>Cost classifications use each instance&rsquo;s current provider configuration; historical configuration changes are not available.</p>
          {usage.coverage.pricingIncomplete && <p className="text-port-warning">Some provider classifications are unavailable. Fleet API cost includes only classified usage and is incomplete.</p>}
          {usage.coverage.classificationUnreported?.length > 0 && <p className="text-port-warning">Provider classifications have not been reported by {usage.coverage.classificationUnreported.join(', ')}.</p>}
          {usage.coverage.missingInstances?.length > 0 && <p className="text-port-warning">No usage snapshot from {usage.coverage.missingInstances.join(', ')}. Totals are incomplete.</p>}
          {usage.coverage.notSyncingInstances?.length > 0 && <p>Usage sync is off for {usage.coverage.notSyncingInstances.join(', ')}. Their saved history remains included.</p>}
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
            Re-read saved transcripts, Grok sessions, and Antigravity media to replace older estimates and record media, long-context, and speed premiums. This changes this machine’s recorded history but makes no provider calls. It cannot repair peer classifications or restore deleted transcripts; use the chart’s coverage details for those gaps.
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
          {backfill?.codex && (backfill.status === 'complete' || backfill.status === 'error') && (
            <p className="text-xs text-port-success mt-1" role="status">{codexRepairLine(backfill.codex)}</p>
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
      <CostReportCard report={report} />

      {/* Free-tier counterpart of the cost report above: ledger-tracked queries
          and tokens on quotas with no usage API (e.g. opencode zen), plus the
          observed limit blocks that stand in for a quota meter. */}
      <FreeTierUsageCard freeTier={usage.freeTier} />

      {/* Claude Code tokens per model (all instances) for the same window. */}
      <ClaudeCodeModelTokensCard period={period} from={from} to={to} isCustom={isCustom} onRefreshed={fetchUsage} transcriptUpdatedAt={usage.transcriptUpdatedAt} fleetRevision={fleetRevision} />

      {/* Same window, split by machine — renders only once a peer's usage has
          synced, so a single-machine install sees no change. */}
      <FleetUsageCard fleet={usage.fleet} onSaved={async () => { onBillingSaved(); await fetchUsage(); }} />

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
            <p className="text-xs text-gray-500 mt-1">Sessions in this period across available instances, by hour in your configured timezone (days recorded before this change are keyed and binned in UTC).</p>
            {usage.coverage?.hourlyIncomplete && <p className="text-xs text-port-warning mt-1">Partial: older sessions or unavailable instances do not provide hourly detail.</p>}
          </> : <p className="text-sm text-gray-500">Hourly data is unavailable for this period.</p>}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6">
        <UsageVolumeLeaderboardCard
          title="Top Providers"
          subtitle="By usage volume"
          items={topProvidersList}
          emptyMessage="No provider data"
          barClassName="from-port-accent to-blue-400"
          renderLabel={(provider) => (
            <>
              <span className="text-white text-sm sm:text-base font-medium truncate">{provider.name}</span>
              {provider.free && <Pill tone="success" size="xs" className="uppercase tracking-wide shrink-0">Local</Pill>}
              {!provider.free && provider.source && <SourcePill source={provider.source} className="shrink-0" />}
            </>
          )}
        />
        <UsageVolumeLeaderboardCard
          title="Top Models"
          subtitle="By token output & volume"
          items={topModelsList}
          emptyMessage="No model data"
          barClassName="from-emerald-500 to-teal-400"
          renderLabel={(model) => (
            <>
              <span className="text-white font-mono text-xs sm:text-sm truncate">{model.model}</span>
              {model.providerName && <span className="text-[10px] text-gray-500 truncate hidden sm:inline">({model.providerName})</span>}
            </>
          )}
        />
      </div>
    </div>
  );
}

export function UsagePage() {
  const [billingRevision, setBillingRevision] = useState(0);
  const onBillingSaved = useCallback(() => setBillingRevision((value) => value + 1), []);
  return (
    <PageLayout header={<PageHeader icon={BarChart3} title="Subscription Usage" />} navigation={<ModelsTabsHeader activeTab="usage" />}>
      <div className="space-y-6">
        <UsageRetentionTips />
        <ProviderQuotaSection billingRevision={billingRevision} />
        <InternalUsageMetrics onBillingSaved={onBillingSaved} />
      </div>
    </PageLayout>
  );
}

export default UsagePage;
