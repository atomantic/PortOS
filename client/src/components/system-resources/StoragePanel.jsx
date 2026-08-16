import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Bot, CheckCircle2, Database, HardDrive, RefreshCw, ShieldCheck, Sparkles } from 'lucide-react';
import { Link } from 'react-router';
import ProviderModelSelector from '../ProviderModelSelector.jsx';
import Banner from '../ui/Banner.jsx';
import CleanupControl from './CleanupControl.jsx';
import useProviderModels from '../../hooks/useProviderModels.js';
import { formatBytes } from '../../utils/formatters.js';
import * as api from '../../services/api.js';
import toast from '../ui/Toast.jsx';

const RISK_STYLE = {
  low: 'bg-port-success/10 text-port-success',
  medium: 'bg-port-warning/10 text-port-warning',
  high: 'bg-port-error/10 text-port-error',
};

const storageSize = (bytes) => (Number.isFinite(bytes) ? formatBytes(bytes) : 'Unavailable');

function ReportEmpty({ loading, onRun }) {
  return (
    <section className="rounded-2xl border border-dashed border-port-accent/40 bg-port-accent/5 px-5 py-8 text-center">
      <HardDrive className="mx-auto mb-3 text-port-accent" size={28} />
      <h3 className="font-semibold text-white">Build a storage inventory</h3>
      <p className="mx-auto mt-2 max-w-2xl text-sm text-gray-400">
        Scan PortOS data, PostgreSQL, model stores, package caches, dependencies, and aggregate Downloads usage.
        The report does not inspect personal filenames.
      </p>
      <button
        type="button"
        onClick={onRun}
        disabled={loading}
        className="mt-4 inline-flex min-h-[40px] items-center gap-2 rounded-lg bg-port-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-port-accent/80 disabled:opacity-50"
      >
        <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
        {loading ? 'Scanning…' : 'Run system report'}
      </button>
    </section>
  );
}

function DiskGauge({ filesystem }) {
  if (!filesystem) return null;
  const pct = Math.min(100, Math.max(0, filesystem.usagePercent));
  const color = pct >= 98 ? '#ef4444' : pct >= 90 ? '#f59e0b' : '#22c55e';
  return (
    <section className="rounded-2xl border border-port-border bg-port-card p-5">
      <div className="grid items-center gap-5 md:grid-cols-[160px_1fr]">
        <div
          className="relative mx-auto grid h-36 w-36 place-items-center rounded-full"
          style={{ background: `conic-gradient(${color} ${pct}%, rgba(75,85,99,.25) ${pct}% 100%)` }}
          role="meter"
          aria-label={`${pct}% disk used`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <div className="grid h-28 w-28 place-items-center rounded-full bg-port-card text-center">
            <div>
              <div className="text-3xl font-bold text-white">{pct}%</div>
              <div className="text-xs text-gray-500">disk used</div>
            </div>
          </div>
        </div>
        <div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Metric label="Used" value={formatBytes(filesystem.usedBytes)} />
            <Metric label="Free" value={formatBytes(filesystem.freeBytes)} tone="text-port-success" />
            <Metric label="Capacity" value={formatBytes(filesystem.totalBytes)} className="col-span-2 sm:col-span-1" />
          </div>
          <p className="mt-4 text-xs leading-relaxed text-gray-500">
            Known-area totals below may overlap: LoRAs are part of PortOS data, and model stores may use shared layers or hardlinks.
          </p>
        </div>
      </div>
    </section>
  );
}

function Metric({ label, value, tone = 'text-white', className = '' }) {
  return (
    <div className={`rounded-xl bg-port-bg/50 p-3 ${className}`}>
      <div className="text-[11px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${tone}`}>{value}</div>
    </div>
  );
}

function StorageAreas({ areas }) {
  const max = Math.max(1, ...(areas || []).map((area) => area.sizeBytes || 0));
  return (
    <section className="rounded-2xl border border-port-border bg-port-card p-4 sm:p-5">
      <div className="mb-4 flex items-center gap-2">
        <Database size={17} className="text-port-accent" />
        <h3 className="font-semibold text-white">Known storage areas</h3>
      </div>
      <div className="space-y-3">
        {(areas || []).map((area) => (
          <div key={area.id} className="rounded-xl bg-port-bg/40 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-gray-200">{area.label}</span>
                  {area.protected && <span className="rounded bg-port-border px-1.5 py-0.5 text-[10px] uppercase text-gray-500">protected</span>}
                </div>
                <p className="mt-0.5 text-xs text-gray-500">{area.note}</p>
              </div>
              <div className="shrink-0 text-sm font-semibold tabular-nums text-white">{storageSize(area.sizeBytes)}</div>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-port-border/60">
              <div
                className="h-full rounded-full bg-gradient-to-r from-port-accent to-cyan-400"
                style={{ width: area.status === 'unavailable' ? '0%' : `${Math.max(1, ((area.sizeBytes || 0) / max) * 100)}%` }}
              />
            </div>
            {area.managePath && (
              <Link to={area.managePath} className="mt-2 inline-block text-xs text-port-accent hover:text-port-accent/80">
                Manage {area.label.toLowerCase()} →
              </Link>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function CandidateRows({ candidates, cleanup }) {
  return (
    <section className="rounded-2xl border border-port-border bg-port-card p-4 sm:p-5">
      <div className="mb-1 flex items-center gap-2">
        <ShieldCheck size={17} className="text-port-success" />
        <h3 className="font-semibold text-white">Cleanup candidates</h3>
      </div>
      <p className="mb-4 text-xs text-gray-500">Only known, bounded PortOS categories get one-click removal. Every destructive action asks for confirmation.</p>
      <div className="space-y-2">
        {(candidates || []).length === 0 ? (
          <p className="rounded-xl bg-port-bg/40 p-4 text-sm text-gray-500">No managed cleanup candidates were found.</p>
        ) : candidates.map((candidate) => (
          <div key={candidate.id} className="flex flex-col gap-3 rounded-xl bg-port-bg/40 p-3 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-gray-200">{candidate.label}</span>
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${RISK_STYLE[candidate.risk] || RISK_STYLE.medium}`}>
                  {candidate.risk} risk
                </span>
                {candidate.loaded && <span className="rounded bg-purple-500/10 px-1.5 py-0.5 text-[10px] uppercase text-purple-300">loaded</span>}
                {candidate.busy && <span className="rounded bg-port-warning/10 px-1.5 py-0.5 text-[10px] uppercase text-port-warning">busy</span>}
              </div>
              <div className="mt-1 text-sm font-semibold tabular-nums text-white">{storageSize(candidate.estimatedBytes)}</div>
              <p className="mt-1 text-xs leading-relaxed text-gray-500">{candidate.reason}</p>
            </div>
            <CleanupControl
              candidate={candidate}
              busy={cleanup.busyId === candidate.id}
              disabled={cleanup.locked}
              confirming={cleanup.isConfirming(candidate.id)}
              onRequest={() => cleanup.request(candidate.id)}
              onCancel={cleanup.cancel}
              onConfirm={() => cleanup.confirm(candidate)}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

function AiTriage({ report, onReport }) {
  const [effort, setEffort] = useState('');
  const [running, setRunning] = useState(false);
  const [triage, setTriage] = useState(null);
  const reportGeneratedAtRef = useRef(report.generatedAt);
  reportGeneratedAtRef.current = report.generatedAt;
  const {
    providers, selectedProviderId, selectedModel, availableModels,
    setSelectedProviderId, setSelectedModel, loading,
  } = useProviderModels({ silent: true, withEffort: true });

  useEffect(() => {
    setTriage((current) => (
      current && current.reportGeneratedAt !== report.generatedAt ? null : current
    ));
  }, [report.generatedAt]);

  const run = async () => {
    if (!selectedProviderId) {
      toast.error('Choose an enabled AI provider first');
      return;
    }
    const startingReportGeneratedAt = reportGeneratedAtRef.current;
    setRunning(true);
    const result = await api.triageSystemResources({
      providerId: selectedProviderId,
      model: selectedModel || undefined,
      effort: effort || undefined,
    }, { silent: true }).catch((error) => {
      toast.error(error?.message || 'AI triage failed');
      return null;
    });
    setRunning(false);
    if (!result || reportGeneratedAtRef.current !== startingReportGeneratedAt) return;
    setTriage({ reportGeneratedAt: result.report.generatedAt, result: result.triage });
    onReport(result.report);
  };

  return (
    <section className="overflow-hidden rounded-2xl border border-purple-500/30 bg-gradient-to-br from-purple-500/10 via-port-card to-port-card p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-purple-500/15 p-2 text-purple-300"><Bot size={19} /></div>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-white">AI cleanup triage</h3>
          <p className="mt-1 text-xs leading-relaxed text-gray-400">
            The selected model receives only aggregate metrics and the bounded candidate list—never paths, filenames, record names, or file contents.
          </p>
        </div>
      </div>
      <div className="mt-4">
        <ProviderModelSelector
          providers={providers}
          selectedProviderId={selectedProviderId}
          selectedModel={selectedModel}
          availableModels={availableModels}
          onProviderChange={setSelectedProviderId}
          onModelChange={setSelectedModel}
          disabled={loading || running}
          effort={effort}
          onEffortChange={setEffort}
          layout="stacked"
          label="Triage provider"
        />
      </div>
      <button
        type="button"
        onClick={run}
        disabled={loading || running || !selectedProviderId || report.cleanupCandidates.length === 0}
        className="mt-4 inline-flex min-h-[40px] items-center gap-2 rounded-lg bg-purple-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-purple-400 disabled:opacity-50"
      >
        <Sparkles size={15} className={running ? 'animate-pulse' : ''} />
        {running ? 'Analyzing candidates…' : 'Ask AI to triage'}
      </button>

      {triage && (
        <div className="mt-5 space-y-3 border-t border-purple-500/20 pt-4">
          <p className="text-sm leading-relaxed text-gray-200">{triage.result.summary}</p>
          {triage.result.recommendations.map((item, index) => (
            <div key={item.candidate.id} className="rounded-xl border border-port-border bg-port-bg/50 p-3">
              <div className="flex items-start gap-2">
                <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-purple-500/20 text-[11px] font-bold text-purple-300">{index + 1}</span>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-white">{item.candidate.label}</span>
                    <span className="text-xs uppercase text-purple-300">{item.priority}</span>
                    <span className="text-xs text-gray-500">{storageSize(item.candidate.estimatedBytes)}</span>
                  </div>
                  <p className="mt-1 text-xs text-gray-300">{item.reason}</p>
                  <p className="mt-1 text-xs text-gray-500">Tradeoff: {item.tradeoff}</p>
                </div>
              </div>
            </div>
          ))}
          {triage.result.cautions.length > 0 && (
            <div className="rounded-xl bg-port-warning/10 p-3 text-xs text-port-warning">
              {triage.result.cautions.map((caution) => <div key={caution}>• {caution}</div>)}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export default function StoragePanel({ report, loading, onRunReport, onReport, cleanup }) {
  if (!report) return <ReportEmpty loading={loading} onRun={onRunReport} />;
  const generated = new Date(report.generatedAt).toLocaleString();
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 rounded-xl border border-port-border bg-port-card p-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm text-gray-200"><CheckCircle2 size={15} className="text-port-success" /> Report ready</div>
          <div className="mt-0.5 text-xs text-gray-500">Generated {generated}</div>
        </div>
        <button
          type="button"
          onClick={onRunReport}
          disabled={loading || cleanup.locked}
          className="inline-flex min-h-[40px] items-center justify-center gap-2 rounded-lg border border-port-border px-3 py-2 text-sm text-gray-300 transition-colors hover:bg-port-border/40 disabled:opacity-50"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          {loading ? 'Scanning…' : 'Refresh report'}
        </button>
      </div>
      {report.sourceErrors.length > 0 && (
        <Banner tone="warning" icon={AlertTriangle}>Some sources were unavailable: {report.sourceErrors.join(', ')}. Other totals remain usable.</Banner>
      )}
      <DiskGauge filesystem={report.filesystem} />
      <div className="grid gap-4 xl:grid-cols-2">
        <StorageAreas areas={report.storageAreas} />
        <CandidateRows candidates={report.cleanupCandidates} cleanup={cleanup} />
      </div>
      <AiTriage report={report} onReport={onReport} />
    </div>
  );
}
