import { Link } from 'react-router-dom';
import {
  CheckCircle, AlertTriangle, XCircle, Circle, ChevronRight, LayoutGrid,
} from 'lucide-react';
import * as api from '../services/api';
import PageSkeleton from '../components/ui/PageSkeleton';
import { useAutoRefetch } from '../hooks/useAutoRefetch';

// Status presentation. Mirrors the server's CAPABILITY_STATUS tiers.
const STATUS_STYLE = {
  ok: { color: 'text-port-success', bg: 'bg-port-success/10', border: 'border-port-success/30', icon: CheckCircle, label: 'Ready' },
  warn: { color: 'text-port-warning', bg: 'bg-port-warning/10', border: 'border-port-warning/30', icon: AlertTriangle, label: 'Degraded' },
  error: { color: 'text-port-error', bg: 'bg-port-error/10', border: 'border-port-error/30', icon: XCircle, label: 'Error' },
  unconfigured: { color: 'text-gray-500', bg: 'bg-port-card', border: 'border-port-border', icon: Circle, label: 'Not set up' },
};

const OVERALL_LABEL = {
  ok: 'All systems ready',
  warn: 'Some systems degraded',
  error: 'Action needed',
  unconfigured: 'Setup incomplete',
};

function CapabilityRow({ cap }) {
  const style = STATUS_STYLE[cap.status] || STATUS_STYLE.unconfigured;
  const Icon = style.icon;
  return (
    <Link
      to={cap.settingsPath}
      className={`flex items-center gap-3 px-4 py-3 rounded-lg border ${style.border} ${style.bg} hover:border-port-accent/60 transition-colors group`}
    >
      <Icon size={18} className={`${style.color} shrink-0`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-white truncate">{cap.label}</span>
          <span className={`text-xs px-1.5 py-0.5 rounded ${style.bg} ${style.color} border ${style.border}`}>
            {style.label}
          </span>
        </div>
        <p className="text-sm text-gray-400 truncate">{cap.summary}</p>
      </div>
      <ChevronRight size={16} className="text-gray-600 group-hover:text-port-accent shrink-0" />
    </Link>
  );
}

export default function CapabilityMap() {
  const { data, loading } = useAutoRefetch(
    () => api.getCapabilities({ silent: true }),
    20_000,
  );

  if (loading) {
    return <PageSkeleton label="Loading capabilities" titleWidthClass="w-40" showSubtitle layout="grid" gridColsClass="lg:grid-cols-2" cards={6} />;
  }

  if (!data) {
    return <div className="p-6 text-gray-400">Capability map unavailable.</div>;
  }

  const caps = Array.isArray(data.capabilities) ? data.capabilities : [];
  const summary = data.summary || { ok: 0, warn: 0, error: 0, unconfigured: 0, overall: 'unconfigured' };
  const overallStyle = STATUS_STYLE[summary.overall] || STATUS_STYLE.unconfigured;
  const OverallIcon = overallStyle.icon;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-xl font-bold text-white flex items-center gap-2">
          <LayoutGrid size={20} />
          Capabilities
        </h2>
        <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border ${overallStyle.border} ${overallStyle.color} ${overallStyle.bg}`}>
          <OverallIcon size={16} />
          <span className="font-semibold">{OVERALL_LABEL[summary.overall] || 'Status'}</span>
        </div>
      </div>

      <p className="text-sm text-gray-500">
        Each connected system's status at a glance — a setup checklist and a runtime health overview.
        Select a row to configure it.
      </p>

      <div className="flex items-center gap-4 text-xs text-gray-400">
        <span className="flex items-center gap-1"><CheckCircle size={12} className="text-port-success" /> {summary.ok} ready</span>
        <span className="flex items-center gap-1"><AlertTriangle size={12} className="text-port-warning" /> {summary.warn} degraded</span>
        <span className="flex items-center gap-1"><XCircle size={12} className="text-port-error" /> {summary.error} error</span>
        <span className="flex items-center gap-1"><Circle size={12} className="text-gray-500" /> {summary.unconfigured} not set up</span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
        {caps.map((cap) => (
          <CapabilityRow key={cap.id} cap={cap} />
        ))}
      </div>
    </div>
  );
}
