import PageHeader from '../components/PageHeader';
import PageLayout from '../components/PageLayout';
import { useState } from 'react';
import toast from '../components/ui/Toast';
import { Link } from 'react-router';
import {
  CheckCircle, AlertTriangle, XCircle, Circle, ChevronRight, ListChecks,
} from 'lucide-react';
import * as api from '../services/api';
import PageSkeleton from '../components/ui/PageSkeleton';
import NetworkSetupGuide from '../components/NetworkSetupGuide.jsx';
import { useSocketResource } from '../hooks/useSocketResource';

const READINESS_EVENTS = ['capabilities:changed', 'localLlm:progress'];
const matchesReadinessEvent = (payload, event) => event !== 'localLlm:progress' || ['complete', 'error'].includes(payload?.event);

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

// Problems lead the list; Array.prototype.sort is stable so server order breaks ties.
const SEVERITY_ORDER = { error: 0, warn: 1, unconfigured: 2, ok: 3 };
const severityRank = (cap) => SEVERITY_ORDER[cap.status] ?? SEVERITY_ORDER.unconfigured;
const NETWORK_PREFERENCE_LABEL = { tailscale: 'Tailscale', tailcat: 'Tailcat', none: 'Not desired' };

function CapabilityRow({ cap, id }) {
  const style = STATUS_STYLE[cap.status] || STATUS_STYLE.unconfigured;
  const Icon = style.icon;
  return (
    <Link
      id={id}
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

function CapabilityMapContent() {
  const [savedPreference, setSavedPreference] = useState(null);
  const [saving, setSaving] = useState(false);
  const { data, loading, error } = useSocketResource(
    () => api.getCapabilities({ silent: true }),
    { namespace: 'readiness', events: READINESS_EVENTS, matchesEvent: matchesReadinessEvent },
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

  const preference = savedPreference ?? data.networkSetupPreference ?? '';
  const savePreference = (value) => {
    setSaving(true);
    api.updateSettings({ networkSetupPreference: value }, { silent: true })
      .then(() => setSavedPreference(value))
      .catch((error) => toast.error(error.message || 'Could not save networking preference'))
      .finally(() => setSaving(false));
  };

  const caps = Array.isArray(data.capabilities) ? data.capabilities : [];
  const summary = data.summary || { ok: 0, warn: 0, error: 0, unconfigured: 0, overall: 'unconfigured' };
  const optionalSummary = data.optionalSummary || summary;
  const setup = data.setup || { total: 0, ready: 0, remaining: 0, complete: false };
  const providerCapability = caps.find((cap) => cap.id === 'providers');
  const optionalCapabilities = caps
    .filter((cap) => cap.setupRequired !== true && cap.id !== 'network')
    .sort((a, b) => severityRank(a) - severityRank(b));
  const overallStyle = STATUS_STYLE[optionalSummary.overall] || STATUS_STYLE.unconfigured;
  const OverallIcon = overallStyle.icon;
  const compact = setup.complete === true;
  const firstAffected = optionalCapabilities.find((cap) => cap.status !== 'ok');
  const problemCounts = [
    [optionalSummary.error, 'error'],
    [optionalSummary.warn, 'degraded'],
    [optionalSummary.unconfigured, 'not set up'],
  ].filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`);
  const jumpToFirstAffected = () => {
    const el = document.getElementById(`capability-${firstAffected.id}`);
    el?.scrollIntoView?.({ block: 'center' });
    el?.focus?.();
  };
  const providerOptions = (
    <>
      <p className="text-xs text-gray-500">
        Enable one option you intend to use: an authenticated subscription CLI, a paid API key, or a local runtime with a downloaded model. PortOS never enables a paid provider or starts model work without your action.
      </p>
      <div className="grid gap-2 text-xs text-gray-400 sm:grid-cols-3">
        <div className="rounded-lg border border-port-border bg-port-bg/40 p-3"><strong className="text-gray-200">Subscription CLI</strong><br />Claude Code, Codex, or Antigravity after local sign-in.</div>
        <div className="rounded-lg border border-port-border bg-port-bg/40 p-3"><strong className="text-gray-200">API provider</strong><br />Add a key only for the paid service you chose.</div>
        <div className="rounded-lg border border-port-border bg-port-bg/40 p-3"><strong className="text-gray-200">Local/private</strong><br />Ollama or LM Studio with a runnable model.</div>
      </div>
    </>
  );
  const networkOptions = (
    <>
      <p className="text-xs text-gray-500">
        Choose Tailscale for private device access, Tailcat to bridge instances, or mark networking as not desired. This preference does not start or stop connections.
      </p>
      <label htmlFor="network-setup-preference" className="block text-sm text-gray-300">Networking preference</label>
      <select id="network-setup-preference" value={preference} disabled={saving}
        onChange={(event) => savePreference(event.target.value)}
        className="w-full rounded-lg border border-port-border bg-port-bg p-2 text-sm text-white">
        <option value="" disabled>Choose an option (optional)</option>
        <option value="tailscale">Tailscale — private device access</option>
        <option value="tailcat">Tailcat — bridge instances</option>
        <option value="none">Not desired</option>
      </select>
      {saving && <p role="status" className="text-xs text-gray-400">Saving preference…</p>}
      {preference === 'tailscale' && <NetworkSetupGuide networkExposure={data.network} />}
      {preference === 'tailcat' && <p className="text-sm text-gray-400">
        Open Instances, choose Tailcat when adding a peer, and dial its address or let it dial yours. Tailscale and its HTTPS certificates are not required.
        {' '}<Link to="/instances" className="text-port-accent underline">Configure Tailcat bridge</Link>
      </p>}
      {preference === 'none' && <p className="text-sm text-gray-400">Networking marked as not desired. You can change this preference at any time.</p>}
    </>
  );
  const disclosure = (children) => (
    <details className="group rounded-lg border border-port-border bg-port-bg/40 px-3 py-2">
      <summary className="cursor-pointer text-sm text-gray-300">Setup options</summary>
      <div className="mt-3 space-y-3">{children}</div>
    </details>
  );

  return (
    <div className="space-y-4">
      {error && <p role="status" className="text-port-warning">Capability refresh failed. Showing the last available reading.</p>}
      <div className="flex items-center justify-end gap-3 flex-wrap">
        <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border ${setup.complete ? STATUS_STYLE.ok.border : STATUS_STYLE.warn.border} ${setup.complete ? STATUS_STYLE.ok.color : STATUS_STYLE.warn.color} ${setup.complete ? STATUS_STYLE.ok.bg : STATUS_STYLE.warn.bg}`}>
          {setup.complete ? <CheckCircle size={16} /> : <AlertTriangle size={16} />}
          <span className="font-semibold">
            {setup.complete ? 'Essential setup complete' : `${setup.remaining} essential ${setup.remaining === 1 ? 'step' : 'steps'} remaining`}
          </span>
        </div>
      </div>

      {!compact && (
        <p className="text-sm text-gray-500">
          Enable at least one runnable AI provider. Networking and other integrations are optional; you can configure them whenever they are useful.
        </p>
      )}

      <section className="space-y-3 rounded-xl border border-port-border bg-port-card p-4 sm:p-5">
        <h3 className="font-semibold text-white">AI provider</h3>
        {providerCapability && <CapabilityRow cap={providerCapability} />}
        {compact ? disclosure(providerOptions) : providerOptions}
      </section>

      <section className="space-y-3 rounded-xl border border-port-border bg-port-card p-4 sm:p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-semibold text-white">Optional networking</h3>
          {compact && <span className="text-sm text-gray-400">{NETWORK_PREFERENCE_LABEL[preference] || 'No preference set'}</span>}
        </div>
        {compact ? disclosure(networkOptions) : networkOptions}
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold text-white">Optional capabilities</h3>
            <p className="mt-1 text-xs text-gray-500">Configure these when they are useful; they do not block initial setup.</p>
          </div>
          {firstAffected ? (
            <button type="button" onClick={jumpToFirstAffected}
              className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-semibold ${overallStyle.border} ${overallStyle.color} ${overallStyle.bg}`}>
              <OverallIcon size={15} />
              <span>{problemCounts.join(' · ')}</span>
            </button>
          ) : (
            <div className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 ${overallStyle.border} ${overallStyle.color} ${overallStyle.bg}`}>
              <OverallIcon size={15} />
              <span className="text-xs font-semibold">{OVERALL_LABEL[optionalSummary.overall] || 'Status'}</span>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
          {optionalCapabilities.map((cap) => (
            <CapabilityRow key={cap.id} cap={cap} id={`capability-${cap.id}`} />
          ))}
        </div>
      </section>
    </div>
  );
}

export default function CapabilityMap() {
  return (
    <PageLayout header={<PageHeader icon={ListChecks} title="Setup & Capabilities" />}>
      <CapabilityMapContent />
    </PageLayout>
  );
}
