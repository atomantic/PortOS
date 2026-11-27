import PageHeader from '../components/PageHeader';
import PageLayout from '../components/PageLayout';
import { useCallback, useState, useEffect } from 'react';
import { BarChart3 } from 'lucide-react';
import { getUsageBackfillStatus, startUsageBackfill } from '../services/apiSystem.js';
import PageSkeleton from '../components/ui/PageSkeleton';
import Pill from '../components/ui/Pill';
import { formatCompactCountOrDash as formatNumber } from '../utils/formatters';
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
import { CostReportCard, CostReportFilters, SourcePill, getPeriodTopModels, getPeriodTopProviders } from '../components/usage/CostReportSection';
import UsageVolumeLeaderboardCard from '../components/usage/UsageVolumeLeaderboardCard';
import ModelsTabsHeader from '../components/models/ModelsTabsHeader';
import UsageCoverageSummary from '../components/usage/UsageCoverageSummary';
import UsageReconcileCard from '../components/usage/UsageReconcileCard';
import CodexImageUsageCard from '../components/usage/CodexImageUsageCard';
import UsageActivityCharts from '../components/usage/UsageActivityCharts';
import useUsageReport from '../components/usage/useUsageReport';

export { arrangeQuotaCells } from '../components/usage/ProviderQuotaSection';

const BACKFILL_EVENTS = ['usage-backfill:updated'];
const IMAGE_USAGE_EVENTS = ['image-gen:completed'];
// A provider app's own usage history changed (Claude Code, Codex, Grok, Antigravity).
const NATIVE_HISTORY_EVENTS = ['usage:native-history-updated'];

function UsageReportControls({ period, from, to, isCustom, usage, loading, readError, loadedRange, fetchUsage, setPeriod, setRange }) {
  return (
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
}

function UsageReportTotals({ totals }) {
  const tokens = (totals?.tokensIn ?? 0) + (totals?.tokensOut ?? 0)
    + (totals?.cacheReadTokens ?? 0) + (totals?.cacheWriteTokens ?? 0);
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
      <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4 text-center">
        <div className="text-xl sm:text-2xl font-bold text-white">{formatNumber(totals?.sessions)}</div>
        <div className="text-xs sm:text-sm text-gray-400">Sessions</div>
      </div>
      <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4 text-center">
        <div className="text-xl sm:text-2xl font-bold text-white">{formatNumber(totals?.messages)}</div>
        <div className="text-xs sm:text-sm text-gray-400">Messages</div>
      </div>
      <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4 text-center">
        <div className="text-xl sm:text-2xl font-bold text-white">{formatNumber(tokens)}</div>
        <div className="text-xs sm:text-sm text-gray-400">Tokens</div>
      </div>
    </div>
  );
}

function InternalUsageMetrics({ onBillingSaved }) {
  const [fleetRevision, setFleetRevision] = useState(0);
  const usageReport = useUsageReport();
  const { period, from, to, isCustom, usage, loading, fetchUsage } = usageReport;
  const { data: backfill, updateData: setBackfill, refetch: refreshBackfill } = useSocketResource(
    () => getUsageBackfillStatus({ silent: true }),
    { events: BACKFILL_EVENTS },
  );

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
    if (backfill?.status === 'complete' || backfill?.status === 'error') {
      setFleetRevision((value) => value + 1);
      fetchUsage();
    }
  }, [backfill, fetchUsage]);

  const reconciling = startingBackfill || backfill?.status === 'running';

  if (!usage) {
    return (
      <div className="space-y-6">
        <h2 className="text-lg font-semibold text-white">PortOS AI Usage</h2>
        <UsageReportControls {...usageReport} />
        {loading && <PageSkeleton label="Loading usage data" titleWidthClass="w-44" showAction={false} layout="grid" gridColsClass="grid-cols-2 sm:grid-cols-4" cards={4} />}
      </div>
    );
  }

  const report = usage.report;
  const topProvidersList = getPeriodTopProviders(usage);
  const topModelsList = getPeriodTopModels(usage);

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-white">PortOS AI Usage</h2>
      {/* Trailing 30 days across every instance — independent of the range below. */}
      <RollingCostCard fleetRevision={fleetRevision} onReconcile={startBackfill} reconciling={reconciling} />
      <MonthlyUsageCard history={usage.monthlyHistory} series={usage.monthlySeries} instanceCount={usage.monthlyInstanceCount} rangeTooWide={usage.monthlyRangeTooWide} coverage={usage.coverage} onReconcile={startBackfill} reconciling={reconciling} />
      <UsageReportControls {...usageReport} />
      <UsageCoverageSummary coverage={usage.coverage} nativeSources={usage.nativeSources} />
      <UsageReconcileCard backfill={backfill} startBackfill={startBackfill} reconciling={reconciling} />
      <CodexImageUsageCard imageRenders={usage.imageRenders} />

      <UsageReportTotals totals={report?.totals} />

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

      <UsageActivityCharts activity={usage.activity} hourlyActivity={usage.hourlyActivity} hourlyIncomplete={usage.coverage?.hourlyIncomplete} />

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
