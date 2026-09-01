import { Link } from 'react-router';
import {
  CheckCircle, AlertTriangle, XCircle, Circle, ChevronRight, ListChecks,
} from 'lucide-react';
import * as api from '../services/api';
import PageSkeleton from '../components/ui/PageSkeleton';
import NetworkSetupGuide from '../components/NetworkSetupGuide.jsx';
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
    return <PageSkeleton
        label="Loading capabilities"
        headerRowClass="flex flex-wrap items-center justify-between gap-3"
        titleWidthClass="w-40"
        showSubtitle
        layout="grid"
        gridColsClass="lg:grid-cols-2"
        cards={6}
      />;
  }

  if (!data) {
    return <div className="p-6 text-gray-400">Capability map unavailable.</div>;
  }

  const caps = Array.isArray(data.capabilities) ? data.capabilities : [];
  const summary = data.summary || { ok: 0, warn: 0, error: 0, unconfigured: 0, overall: 'unconfigured' };
  const optionalSummary = data.optionalSummary || summary;
  const setup = data.setup || { total: 0, ready: 0, remaining: 0, complete: false };
  const providerCapability = caps.find((cap) => cap.id === 'providers');
  const optionalCapabilities = caps.filter((cap) => cap.setupRequired !== true);
  const overallStyle = STATUS_STYLE[optionalSummary.overall] || STATUS_STYLE.unconfigured;
  const OverallIcon = overallStyle.icon;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-xl font-bold text-white flex items-center gap-2">
          <ListChecks size={20} />
          Setup &amp; Capabilities
        </h2>
        <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border ${setup.complete ? STATUS_STYLE.ok.border : STATUS_STYLE.warn.border} ${setup.complete ? STATUS_STYLE.ok.color : STATUS_STYLE.warn.color} ${setup.complete ? STATUS_STYLE.ok.bg : STATUS_STYLE.warn.bg}`}>
          {setup.complete ? <CheckCircle size={16} /> : <AlertTriangle size={16} />}
          <span className="font-semibold">
            {setup.complete ? 'Essential setup complete' : `${setup.remaining} essential ${setup.remaining === 1 ? 'step' : 'steps'} remaining`}
          </span>
        </div>
      </div>

      <p className="text-sm text-gray-500">
        Finish secure remote access and enable at least one runnable AI provider. Optional integrations stay below as a health overview.
      </p>

      <section className="space-y-3 rounded-xl border border-port-border bg-port-card p-4 sm:p-5">
        <div>
          <h3 className="font-semibold text-white">1. Tailscale, MagicDNS &amp; HTTPS</h3>
          <p className="mt-1 text-xs text-gray-500">
            PortOS automates certificate provisioning once Tailscale is connected and HTTPS Certificates are enabled in the tailnet.
          </p>
        </div>
        <NetworkSetupGuide networkExposure={data.network} />
      </section>

      <section className="space-y-3 rounded-xl border border-port-border bg-port-card p-4 sm:p-5">
        <div>
          <h3 className="font-semibold text-white">2. AI provider</h3>
          <p className="mt-1 text-xs text-gray-500">
            Enable one option you intend to use: an authenticated subscription CLI, a paid API key, or a local runtime with a downloaded model. PortOS never enables a paid provider or starts model work without your action.
          </p>
        </div>
        {providerCapability && <CapabilityRow cap={providerCapability} />}
        <div className="grid gap-2 text-xs text-gray-400 sm:grid-cols-3">
          <div className="rounded-lg border border-port-border bg-port-bg/40 p-3"><strong className="text-gray-200">Subscription CLI</strong><br />Claude Code, Codex, or Antigravity after local sign-in.</div>
          <div className="rounded-lg border border-port-border bg-port-bg/40 p-3"><strong className="text-gray-200">API provider</strong><br />Add a key only for the paid service you chose.</div>
          <div className="rounded-lg border border-port-border bg-port-bg/40 p-3"><strong className="text-gray-200">Local/private</strong><br />Ollama or LM Studio with a runnable model.</div>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold text-white">Optional capabilities</h3>
            <p className="mt-1 text-xs text-gray-500">Configure these when they are useful; they do not block initial setup.</p>
          </div>
          <div className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 ${overallStyle.border} ${overallStyle.color} ${overallStyle.bg}`}>
            <OverallIcon size={15} />
            <span className="text-xs font-semibold">{OVERALL_LABEL[optionalSummary.overall] || 'Status'}</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4 text-xs text-gray-400">
          <span className="flex items-center gap-1"><CheckCircle size={12} className="text-port-success" /> {optionalSummary.ok} ready</span>
          <span className="flex items-center gap-1"><AlertTriangle size={12} className="text-port-warning" /> {optionalSummary.warn} degraded</span>
          <span className="flex items-center gap-1"><XCircle size={12} className="text-port-error" /> {optionalSummary.error} error</span>
          <span className="flex items-center gap-1"><Circle size={12} className="text-gray-500" /> {optionalSummary.unconfigured} not set up</span>
        </div>

        <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
          {optionalCapabilities.map((cap) => (
            <CapabilityRow key={cap.id} cap={cap} />
          ))}
        </div>
      </section>
    </div>
  );
}
