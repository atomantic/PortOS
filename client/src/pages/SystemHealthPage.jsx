import { useEffect, useState, useRef } from 'react';
import { Link, Navigate, NavLink, useParams } from 'react-router';
import { Activity, AlertTriangle, CheckCircle, XCircle, HardDrive, Cpu, Database, ListOrdered, RefreshCw, ServerCog, Zap } from 'lucide-react';
import * as api from '../services/api';
import toast from '../components/ui/Toast';
import PageSkeleton from '../components/ui/PageSkeleton';
import Banner from '../components/ui/Banner';
import { useAutoRefetch } from '../hooks/useAutoRefetch';
import { useSystemResourceReport } from '../hooks/useSystemResourceReport.js';
import StoragePanel from '../components/system-resources/StoragePanel.jsx';
import QueuesPanel from '../components/system-resources/QueuesPanel.jsx';
import MediaCapacityPanel from '../components/system-resources/MediaCapacityPanel.jsx';
import BuildStampPanel from '../components/system-resources/BuildStampPanel.jsx';

const HEALTH_STYLE = {
  healthy: { color: 'text-port-success', bg: 'bg-port-success/10', icon: CheckCircle, label: 'Healthy' },
  warning: { color: 'text-port-warning', bg: 'bg-port-warning/10', icon: AlertTriangle, label: 'Warning' },
  critical: { color: 'text-port-error', bg: 'bg-port-error/10', icon: XCircle, label: 'Critical' }
};

// Every alert names its own next step. The server tags each warning with a
// `type` (server/routes/systemHealth.js), so the banner can carry the link that
// actually resolves it instead of leaving the user to hunt for the right page.
// `forge` is intentionally absent — its message already embeds gh's own remedy
// text and there is no in-app page that fixes it.
const REMEDIATION = {
  disk: { to: '/system-resources/storage', label: 'Disk usage breakdown' },
  memory: { to: '/devtools/processes', label: 'All processes' },
  cpu: { to: '/devtools/processes', label: 'All processes' },
  process: { to: '/devtools/processes', label: 'All processes' },
  restarts: { to: '/devtools/processes', label: 'All processes' },
  apps: { to: '/apps', label: 'Apps' },
  database: { to: '/settings/database', label: 'Database settings' },
};

// Drill-in links shown directly under the alerts so at least one next step is
// above the fold at phone widths (375px), where the metric cards alone push
// every control off-screen. Derived from REMEDIATION so a link's label and
// destination can't drift between the banner and the nav.
const DRILL_INS = ['disk', 'process', 'apps'].map(type => REMEDIATION[type]);

function pctTone(pct, warn, critical) {
  if (pct >= critical) return 'text-port-error';
  if (pct >= warn) return 'text-port-warning';
  return 'text-port-success';
}

function barTone(pct, warn, critical) {
  if (pct >= critical) return 'bg-port-error';
  if (pct >= warn) return 'bg-port-warning';
  return 'bg-port-success';
}

// The downloaded-model inventory used to be a fourth tab here. It answered the
// same question Models → Status answers, in a different section, so it folded
// into that page (#4728); /system-resources/models redirects there.
export const RESOURCE_TABS = [
  { id: 'overview', label: 'Overview', icon: Activity },
  { id: 'storage', label: 'Storage', icon: HardDrive },
  { id: 'queues', label: 'Queues', icon: ListOrdered },
];

export default function SystemResourcesPage() {
  const { tab = 'overview' } = useParams();
  // The scan + cleanup lifecycle is shared with Models → Status, which renders
  // the same server report from a different section.
  const { report, setReport, loading: reportLoading, runReport, cleanup } = useSystemResourceReport();

  const validTab = RESOURCE_TABS.some((item) => item.id === tab);
  if (!validTab) return <Navigate to="/system-resources/overview" replace />;

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <header className="overflow-hidden rounded-2xl border border-port-border bg-gradient-to-r from-port-card via-port-card to-port-accent/10 p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-port-accent/15 p-2.5 text-port-accent"><ServerCog size={22} /></div>
          <div>
            <h1 className="text-xl font-bold text-white">System Resources</h1>
            <p className="mt-1 max-w-3xl text-sm text-gray-400">
              Health, disk intelligence, and active work queues in one control center.
            </p>
          </div>
        </div>
        <nav aria-label="System resources sections" className="mt-5 grid grid-cols-3 border-b border-port-border sm:flex sm:gap-1">
          {RESOURCE_TABS.map(({ id, label, icon: Icon }) => (
            <NavLink
              key={id}
              to={`/system-resources/${id}`}
              className={({ isActive }) => `flex min-h-[40px] items-center justify-center gap-1 border-b-2 px-1 py-2 text-xs transition-colors sm:shrink-0 sm:gap-1.5 sm:px-3 sm:text-sm ${
                isActive ? 'border-port-accent text-white' : 'border-transparent text-gray-500 hover:text-gray-200'
              }`}
            >
              <Icon size={14} /> {label}
            </NavLink>
          ))}
        </nav>
      </header>

      {tab === 'overview' && <SystemHealthOverview />}
      {tab === 'storage' && (
        <StoragePanel
          report={report}
          loading={reportLoading}
          onRunReport={runReport}
          onReport={setReport}
          cleanup={cleanup}
        />
      )}
      {tab === 'queues' && <QueuesPanel />}
    </div>
  );
}

function SystemHealthOverview() {
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Tracks whether the user has acquired an editable draft. Cleared after a
  // successful save so the next refetch re-seeds with the persisted thresholds.
  const draftSeededRef = useRef(false);

  const { data: health, loading, refetch } = useAutoRefetch(
    () => api.getSystemHealth({ silent: true }),
    15_000,
  );

  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  };

  // Seed the editable draft from server state on first load and after each save.
  useEffect(() => {
    if (health?.thresholds && !draftSeededRef.current) {
      setDraft(health.thresholds);
      draftSeededRef.current = true;
    }
  }, [health]);

  const handleSaveThresholds = async () => {
    if (!draft) return;
    setSaving(true);
    const result = await api.updateHealthThresholds(draft, { silent: true }).catch(err => {
      toast.error(err?.message || 'Failed to save thresholds');
      return null;
    });
    setSaving(false);
    if (result) {
      toast.success('Thresholds saved');
      draftSeededRef.current = false;
      await handleRefresh();
    }
  };

  const handleResetThresholds = () => {
    setDraft({ memoryWarn: 85, memoryCritical: 95, diskWarn: 90, diskCritical: 98 });
  };

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto">
        <PageSkeleton
          label="Loading system health"
          headerRowClass="flex items-center justify-between gap-3"
          titleWidthClass="w-48"
          layout="grid"
          gridColsClass="md:grid-cols-3"
          cards={3}
        />
      </div>
    );
  }

  if (!health) {
    return <div className="p-6 text-gray-400">System health unavailable.</div>;
  }

  const style = HEALTH_STYLE[health.overallHealth] || HEALTH_STYLE.healthy;
  const StatusIcon = style.icon;
  const t = health.thresholds;
  const draftValid =
    draft &&
    draft.memoryWarn < draft.memoryCritical &&
    draft.diskWarn < draft.diskCritical;
  const draftDirty =
    draft &&
    (draft.memoryWarn !== t.memoryWarn ||
      draft.memoryCritical !== t.memoryCritical ||
      draft.diskWarn !== t.diskWarn ||
      draft.diskCritical !== t.diskCritical);

  return (
    <div className="max-w-5xl mx-auto space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <ServerCog size={20} />
            Live health
          </h2>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={handleRefresh}
              disabled={refreshing}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-port-border bg-port-card px-3 py-1.5 text-sm text-gray-300 transition-colors hover:border-gray-600 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
              title="Refresh system health"
              aria-label={refreshing ? 'Refreshing system health' : 'Refresh system health'}
            >
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} aria-hidden="true" />
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border border-current/20 ${style.color} ${style.bg}`}>
              <StatusIcon size={16} />
              <span className="font-semibold">{style.label}</span>
              <span className="text-gray-500">·</span>
              <span className="text-gray-400 text-sm">{health.system.uptimeFormatted}</span>
            </div>
          </div>
        </div>

        {health.warnings.length > 0 && (
          <section className="space-y-2">
            {health.warnings.map((w, i) => {
              const remedy = REMEDIATION[w.type];
              return (
                <Banner key={`${w.type || 'warning'}-${i}`} tone="warning" size="md" icon={AlertTriangle} align="start">
                  <div>{w.message}</div>
                  {remedy && (
                    <Link to={remedy.to} className="inline-block mt-1 font-medium underline underline-offset-2 hover:no-underline">
                      {remedy.label} →
                    </Link>
                  )}
                </Banner>
              );
            })}
          </section>
        )}

        <nav aria-label="System drill-downs" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          {DRILL_INS.map(link => (
            <Link key={link.to} to={link.to} className="text-port-accent hover:text-port-accent/80">{link.label} →</Link>
          ))}
        </nav>

        <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <ResourceCard
            icon={HardDrive}
            label="Memory"
            pct={health.system.memory.usagePercent}
            warn={t.memoryWarn}
            critical={t.memoryCritical}
            sub={`${health.system.memory.usedFormatted} / ${health.system.memory.totalFormatted}`}
          />
          <ResourceCard
            icon={Cpu}
            label="CPU Load (1m)"
            pct={Math.min(100, health.system.cpu.usagePercent)}
            warn={75}
            critical={100}
            sub={`${health.system.cpu.cores} cores · ${health.system.cpu.loadAvg1m.toFixed(2)} load`}
          />
          {health.system.disk && (
            <ResourceCard
              icon={Database}
              label="Disk"
              pct={health.system.disk.usagePercent}
              warn={t.diskWarn}
              critical={t.diskCritical}
              sub={`${health.system.disk.usedFormatted} / ${health.system.disk.totalFormatted}`}
            />
          )}
        </section>

        <MediaCapacityPanel media={health.media} />

        <BuildStampPanel uptimeFormatted={health.system.uptimeFormatted} />

        <section className="bg-port-card border border-port-border rounded-xl p-4">
          <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
            <Activity size={16} />
            Top processes by memory
          </h3>
          {health.topProcesses && health.topProcesses.length > 0 ? (
            <div className="space-y-1">
              {health.topProcesses.map((p) => (
                <div key={p.name} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-port-bg/40 hover:bg-port-bg/60 text-sm">
                  <span className={`w-2 h-2 rounded-full ${p.status === 'online' ? 'bg-port-success' : p.status === 'errored' ? 'bg-port-error' : 'bg-gray-500'}`} />
                  <span className="flex-1 text-gray-200 font-mono text-xs truncate">{p.name}</span>
                  <span className="text-gray-400 tabular-nums">{p.cpu.toFixed(0)}% CPU</span>
                  <span className="text-gray-100 tabular-nums w-24 text-right">{p.memoryFormatted}</span>
                  {p.unstableRestarts > 0 && (
                    <span className="text-port-warning text-xs">{p.unstableRestarts} crash-loop</span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-gray-500 text-sm">No PM2 processes reporting.</p>
          )}
          <div className="mt-3 text-xs">
            <Link to="/devtools/processes" className="text-port-accent hover:text-port-accent/80">All processes →</Link>
          </div>
        </section>

        <section className="bg-port-card border border-port-border rounded-xl p-4">
          <div className="flex items-center justify-between mb-3 gap-3">
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <Zap size={16} />
              Alert thresholds
            </h3>
            <span className="text-xs text-gray-500">Tune to your machine. Defaults: 85/95 mem, 90/98 disk.</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <ThresholdField id="system-health-memory-warn" label="Memory warn %" value={draft?.memoryWarn} onChange={(v) => setDraft(d => ({ ...d, memoryWarn: v }))} />
            <ThresholdField id="system-health-memory-critical" label="Memory critical %" value={draft?.memoryCritical} onChange={(v) => setDraft(d => ({ ...d, memoryCritical: v }))} />
            <ThresholdField id="system-health-disk-warn" label="Disk warn %" value={draft?.diskWarn} onChange={(v) => setDraft(d => ({ ...d, diskWarn: v }))} />
            <ThresholdField id="system-health-disk-critical" label="Disk critical %" value={draft?.diskCritical} onChange={(v) => setDraft(d => ({ ...d, diskCritical: v }))} />
          </div>
          {!draftValid && (
            <p className="mt-2 text-xs text-port-error">Warn thresholds must be lower than critical thresholds.</p>
          )}
          <div className="mt-3 flex gap-2">
            <button
              onClick={handleSaveThresholds}
              disabled={!draftDirty || !draftValid || saving}
              className="px-3 py-2 text-sm bg-port-accent hover:bg-port-accent/80 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-white transition-colors"
            >
              {saving ? 'Saving…' : 'Save thresholds'}
            </button>
            <button
              onClick={handleResetThresholds}
              className="px-3 py-2 text-sm bg-port-border/50 hover:bg-port-border rounded-lg text-gray-300 transition-colors"
            >
              Reset to defaults
            </button>
          </div>
        </section>
    </div>
  );
}

function ResourceCard({ icon: Icon, label, pct, warn, critical, sub }) {
  return (
    <div className="bg-port-card border border-port-border rounded-xl p-4">
      <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-gray-500 mb-2">
        <Icon size={14} />
        {label}
      </div>
      <div className={`text-3xl font-bold ${pctTone(pct, warn, critical)}`}>{Math.round(pct)}%</div>
      <div className="text-xs text-gray-500 mt-1">{sub}</div>
      <div className="mt-3 h-1.5 bg-port-border rounded-full overflow-hidden">
        <div className={`h-full ${barTone(pct, warn, critical)} transition-all`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <div className="mt-2 text-[11px] text-gray-600">
        warn {warn}% · critical {critical}%
      </div>
    </div>
  );
}

function ThresholdField({ id, label, value, onChange }) {
  return (
    <label htmlFor={id} className="flex flex-col gap-1 text-xs text-gray-400">
      <span>{label}</span>
      <input
        id={id}
        type="number"
        min={50}
        max={99}
        value={value ?? ''}
        onChange={(e) => onChange(Number(e.target.value))}
        className="bg-port-bg border border-port-border rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-port-accent"
      />
    </label>
  );
}
