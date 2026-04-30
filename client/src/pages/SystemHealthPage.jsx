import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, AlertTriangle, CheckCircle, XCircle, HardDrive, Cpu, Database, ServerCog, Zap } from 'lucide-react';
import * as api from '../services/api';
import toast from '../components/ui/Toast';
import BrailleSpinner from '../components/BrailleSpinner';

const HEALTH_STYLE = {
  healthy: { color: 'text-port-success', bg: 'bg-port-success/10', icon: CheckCircle, label: 'Healthy' },
  warning: { color: 'text-port-warning', bg: 'bg-port-warning/10', icon: AlertTriangle, label: 'Warning' },
  critical: { color: 'text-port-error', bg: 'bg-port-error/10', icon: XCircle, label: 'Critical' }
};

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

export default function SystemHealthPage() {
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = async ({ seedDraft = false } = {}) => {
    const data = await api.getSystemHealth({ silent: true }).catch(() => null);
    setHealth(data);
    if (data?.thresholds && seedDraft) setDraft(data.thresholds);
    setLoading(false);
  };

  useEffect(() => {
    load({ seedDraft: true });
    const interval = setInterval(() => load(), 15000);
    return () => clearInterval(interval);
  }, []);

  const handleSaveThresholds = async () => {
    if (!draft) return;
    setSaving(true);
    const result = await api.updateHealthThresholds(draft).catch(err => {
      toast.error(err?.message || 'Failed to save thresholds');
      return null;
    });
    setSaving(false);
    if (result) {
      toast.success('Thresholds saved');
      load({ seedDraft: true });
    }
  };

  const handleResetThresholds = () => {
    setDraft({ memoryWarn: 85, memoryCritical: 95, diskWarn: 90, diskCritical: 98 });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <BrailleSpinner text="Loading system health" />
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
    <div className="h-full overflow-auto p-4 md:p-6">
      <div className="max-w-5xl mx-auto space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <ServerCog size={20} />
            System Health
          </h2>
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border border-current/20 ${style.color} ${style.bg}`}>
            <StatusIcon size={16} />
            <span className="font-semibold">{style.label}</span>
            <span className="text-gray-500">·</span>
            <span className="text-gray-400 text-sm">{health.system.uptimeFormatted}</span>
          </div>
        </div>

        {health.warnings.length > 0 && (
          <section className="space-y-2">
            {health.warnings.map((w, i) => (
              <div key={i} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-port-warning/10 border border-port-warning/30 text-port-warning text-sm">
                <AlertTriangle size={14} />
                <span>{w.message}</span>
              </div>
            ))}
          </section>
        )}

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
          <div className="mt-3 flex items-center gap-3 text-xs">
            <Link to="/devtools/processes" className="text-port-accent hover:text-port-accent/80">All processes →</Link>
            <Link to="/apps" className="text-port-accent hover:text-port-accent/80">Apps →</Link>
            <Link to="/data" className="text-port-accent hover:text-port-accent/80">Disk usage breakdown →</Link>
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
            <ThresholdField label="Memory warn %" value={draft?.memoryWarn} onChange={(v) => setDraft(d => ({ ...d, memoryWarn: v }))} />
            <ThresholdField label="Memory critical %" value={draft?.memoryCritical} onChange={(v) => setDraft(d => ({ ...d, memoryCritical: v }))} />
            <ThresholdField label="Disk warn %" value={draft?.diskWarn} onChange={(v) => setDraft(d => ({ ...d, diskWarn: v }))} />
            <ThresholdField label="Disk critical %" value={draft?.diskCritical} onChange={(v) => setDraft(d => ({ ...d, diskCritical: v }))} />
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

function ThresholdField({ label, value, onChange }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-gray-400">
      <span>{label}</span>
      <input
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
