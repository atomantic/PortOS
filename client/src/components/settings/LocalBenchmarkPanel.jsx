/**
 * Side-by-side local benchmark: pick two or more installed models (the same weights on two
 * runtimes, say an Ollama MLX build against an MTPLX pack), run the SAME fixed warm benchmark on
 * each, and read decode tok/s, prefill tok/s, first-token time and resident memory in one table.
 *
 * - **Consent names real numbers** (root AGENTS.md, AI Provider Usage Policy). The profile comes
 *   from the server's report (`benchmarkProfile`), and only the model list is sent, so the
 *   generations the gate names are the ones that run.
 * - **One queue.** The run rides the server-side sweep queue, so its progress and Stop button live
 *   in `AssessmentSweepPanel`; this panel only selects, gates and tabulates.
 * - **The selection is in the URL** (`benchModels`, encoded assessment keys), so a comparison is
 *   shareable and survives a reload.
 * - Results are ordinary backend-defaults assessments, which the Models › Comparison measured axes
 *   read. The table shows the reading on record for each model, whichever run produced it.
 */

import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { PlayCircle, History } from 'lucide-react';
import Modal from '../ui/Modal';
import BrailleSpinner from '../BrailleSpinner';
import toast from '../ui/Toast';
import useUrlParams from '../../hooks/useUrlParams';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { formatContextTokens, formatCount, timeAgo } from '../../utils/formatters';
import { decodeLocalModelAssessmentKey, encodeLocalModelAssessmentKey } from '../../lib/localModelAssessmentKey';
import { startLocalLlmAssessmentBenchmark } from '../../services/apiLocalLlm.js';

const keyOf = (m) => `${m.backend}:${m.modelId}`;

/**
 * Installed models the benchmark can run, one per runtime + model: every still-installed record
 * plus every never-measured listing, in runtime then model order.
 */
export function benchmarkCandidates(report) {
  const uninstalled = new Set((report?.uninstalled || []).map(keyOf));
  const byKey = new Map();
  for (const m of [...(report?.assessments || []), ...(report?.unassessed || [])]) {
    if (!m?.backend || !m?.modelId || uninstalled.has(keyOf(m)) || byKey.has(keyOf(m))) continue;
    byKey.set(keyOf(m), { backend: m.backend, modelId: m.modelId });
  }
  return [...byKey.values()].sort((a, b) => a.backend.localeCompare(b.backend) || a.modelId.localeCompare(b.modelId));
}

/** Generations one benchmark of `count` models runs: the discarded warm-up plus the measured runs. */
export const benchmarkGenerations = (count, profile) => count * ((profile?.runs || 0) + (profile?.warmupRuns || 0));

/** The backend-defaults record for a model: what the benchmark writes and the comparison axes read. */
const defaultsRecord = (report, model) => (report?.assessments || [])
  .find((a) => a?.backend === model.backend && a?.modelId === model.modelId && !a?.tuningKey) || null;

const COLUMNS = [
  { id: 'decode', label: 'Decode tok/s', field: 'meanTokensPerSecond', better: 'higher', rate: true },
  { id: 'prefill', label: 'Prefill tok/s', field: 'meanPromptTokensPerSecond', better: 'higher', rate: true },
  { id: 'ttft', label: 'First token', field: 'meanTtftMs', better: 'lower', unit: ' ms' },
];

const numberOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function BenchmarkConsentModal({ models, profile, runtimeLabelFor, starting, onCancel, onConfirm }) {
  const generations = benchmarkGenerations(models.length, profile);
  return (
    <Modal open onClose={onCancel} size="sm" ariaLabel="Benchmark local models side by side" closeOnEsc={!starting} closeOnBackdrop={!starting}>
      <div className="bg-port-card border border-port-border rounded-lg p-5 space-y-4">
        <div className="flex items-center gap-2">
          <PlayCircle size={18} className="text-port-accent" />
          <h3 className="text-white font-medium">Benchmark {models.length} models side by side?</h3>
        </div>
        <ul className="border border-port-border rounded-lg divide-y divide-port-border">
          {models.map((m) => (
            <li key={keyOf(m)} className="px-2.5 py-1.5 text-[11px] text-gray-300 break-all">
              <span className="text-gray-500">{runtimeLabelFor(m.backend)} · </span><span className="font-mono">{m.modelId}</span>
            </li>
          ))}
        </ul>
        <p className="text-sm text-gray-400">
          PortOS will run <span className="text-gray-200">{generations}</span> generations in total: per model,{' '}
          {profile.warmupRuns} discarded warm-up then {profile.runs} measured runs of {formatCount(profile.maxTokens)} output
          tokens on a {formatContextTokens(profile.contextTokens)}-token prompt, at backend defaults.
        </p>
        <p className="text-xs text-gray-500">
          Models run one at a time on the shared measurement queue. A runtime PortOS tuned earlier is restarted on its
          defaults first. Each result replaces that model&apos;s backend-defaults reading and feeds the Models › Comparison
          speed axes. You can stop it from the sweep controls above; finished models are kept.
        </p>
        <div className="flex gap-3 pt-1">
          <button onClick={onCancel} disabled={starting} className="flex-1 px-4 py-2 bg-port-card border border-port-border hover:border-port-accent text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50">
            Cancel
          </button>
          <button onClick={onConfirm} disabled={starting} className="flex-1 px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-port-on-accent text-sm font-medium rounded-lg transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
            {starting ? <><BrailleSpinner /> Starting…</> : <>Start benchmark</>}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function SideBySideTable({ models, report, runtimeLabelFor }) {
  const records = models.map((m) => ({ model: m, record: defaultsRecord(report, m) }));
  // Best per column among measured values only; one measured model has nothing to beat.
  const best = Object.fromEntries(COLUMNS.map((col) => {
    const values = records.map(({ record }) => numberOrNull(record?.performance?.[col.field])).filter((v) => v !== null);
    return [col.id, values.length >= 2 ? (col.better === 'higher' ? Math.max(...values) : Math.min(...values)) : null];
  }));
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-xs" aria-label="Side-by-side benchmark results">
        <thead>
          <tr className="text-gray-500">
            <th className="p-2 font-medium">Model</th>
            {COLUMNS.map((col) => <th key={col.id} className="p-2 font-medium">{col.label} <span className="text-gray-600">({col.better} is better)</span></th>)}
            <th className="p-2 font-medium">Resident</th>
            <th className="p-2 font-medium">Evidence</th>
          </tr>
        </thead>
        <tbody>
          {records.map(({ model, record }) => {
            const perf = record?.performance || {};
            return (
              <tr key={keyOf(model)} className="border-t border-port-border align-top">
                <td className="p-2 text-gray-300 break-all"><span className="text-gray-500">{runtimeLabelFor(model.backend)} · </span><span className="font-mono">{model.modelId}</span></td>
                {COLUMNS.map((col) => {
                  const value = numberOrNull(perf[col.field]);
                  if (value === null) return <td key={col.id} className="p-2 text-gray-500">{record ? 'Not reported' : 'Not measured'}</td>;
                  const estimated = col.rate && perf.tokensEstimated === true;
                  return (
                    <td key={col.id} className={`p-2 ${value === best[col.id] ? 'text-emerald-400 font-semibold' : 'text-gray-200'}`}>
                      {estimated ? '~' : ''}{formatCount(value, { maximumFractionDigits: col.rate ? 1 : 0 })}{col.unit || ''}
                    </td>
                  );
                })}
                <td className="p-2 text-gray-200">{numberOrNull(record?.residentGb) === null ? <span className="text-gray-500">{record ? 'Not reported' : '—'}</span> : `${formatCount(record.residentGb, { maximumFractionDigits: 1 })} GB`}</td>
                <td className="p-2 text-gray-500">
                  {record ? (
                    <>
                      {record.profile === 'benchmark' ? 'Benchmark' : 'Context sweep'} · {timeAgo(record.assessedAt, 'date not recorded')}
                      {record.staleness?.stale && (
                        <span className="flex items-center gap-1 text-port-warning" title={record.staleness.description || undefined}><History size={9} /> stale</span>
                      )}
                    </>
                  ) : 'No backend-defaults reading yet'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * @param {object} props
 * @param {object|null} props.report the assessment report (`GET /api/local-llm/assessments`)
 * @param {(id: string) => string} props.runtimeLabelFor runtime id → label
 * @param {boolean} props.disabled a single run or the sweep queue is holding the machine
 */
export default function LocalBenchmarkPanel({ report, runtimeLabelFor, disabled }) {
  const [searchParams, updateParams] = useUrlParams();
  const [showConsent, setShowConsent] = useState(false);
  const candidates = useMemo(() => benchmarkCandidates(report), [report]);
  const profile = report?.benchmarkProfile || null;

  const selectedKeys = useMemo(() => new Set((searchParams.get('benchModels') || '').split(',').filter(Boolean)
    .map(decodeLocalModelAssessmentKey).filter(Boolean).map(keyOf)), [searchParams]);
  // Candidate order, not click order, so the table reads the same however it was built.
  const selected = candidates.filter((m) => selectedKeys.has(keyOf(m)));

  const writeSelection = (models) => updateParams({
    benchModels: models.map((m) => encodeLocalModelAssessmentKey({ backend: m.backend, modelId: m.modelId })).join(','),
  }, { replace: true });
  const toggle = (model) => writeSelection(selectedKeys.has(keyOf(model))
    ? selected.filter((m) => keyOf(m) !== keyOf(model))
    : [...selected, model]);

  const [start, starting] = useAsyncAction(async () => {
    const next = await startLocalLlmAssessmentBenchmark({ models: selected.map(({ backend, modelId }) => ({ backend, modelId })) }, { silent: true });
    setShowConsent(false);
    toast.success(`Benchmark started — ${next.total} model${next.total === 1 ? '' : 's'} queued`);
    return next;
  }, { errorMessage: 'Could not start the benchmark' });

  const tooFew = selected.length < (profile?.minModels ?? 2);
  const tooMany = profile ? selected.length > profile.maxModels : false;

  return (
    <section className="bg-port-card border border-port-border rounded-xl p-4 space-y-3" aria-label="Side-by-side benchmark">
      <div>
        <h3 className="text-sm font-medium text-white">Side-by-side benchmark</h3>
        <p className="text-[11px] text-gray-500">
          Run the same warm benchmark on several local models or runtimes, then compare them in one table.
          {profile && <> Each model gets {profile.warmupRuns} discarded warm-up and {profile.runs} measured runs of {formatCount(profile.maxTokens)} output tokens on a {formatContextTokens(profile.contextTokens)}-token prompt.</>}
        </p>
      </div>

      {!candidates.length ? (
        <p className="text-xs text-gray-500">
          {report ? <>No local models are available to benchmark. <Link to="/models/llms-runtimes" className="text-port-accent hover:underline">View runtimes</Link></> : 'Loading installed models…'}
        </p>
      ) : (
        <fieldset className="flex flex-wrap gap-2" disabled={starting}>
          <legend className="sr-only">Models to benchmark</legend>
          {candidates.map((m) => {
            const id = `bench-${encodeLocalModelAssessmentKey({ backend: m.backend, modelId: m.modelId })}`;
            return (
              <div key={keyOf(m)} className="flex items-center gap-1.5 rounded-lg border border-port-border px-2 py-1.5 min-w-0 max-w-full">
                <input id={id} type="checkbox" checked={selectedKeys.has(keyOf(m))} onChange={() => toggle(m)} className="accent-port-accent" />
                <label htmlFor={id} className="text-[11px] text-gray-300 break-all min-w-0">
                  <span className="text-gray-500">{runtimeLabelFor(m.backend)} · </span>{m.modelId}
                </label>
              </div>
            );
          })}
        </fieldset>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => setShowConsent(true)}
          disabled={disabled || starting || tooFew || tooMany || !profile}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-port-accent hover:bg-port-accent/80 text-port-on-accent font-medium transition-colors disabled:opacity-50"
        >
          <PlayCircle size={13} /> Benchmark {selected.length || ''} selected
        </button>
        <span className="text-[11px] text-gray-500">
          {tooFew ? `Pick at least ${profile?.minModels ?? 2} models.` : tooMany ? `Pick at most ${profile.maxModels} models per run.` : disabled ? 'Waiting for the current measurement to finish.' : null}
        </span>
        {selected.length > 0 && (
          <button onClick={() => writeSelection([])} className="px-3 py-1.5 text-xs rounded-lg border border-port-border text-gray-300 hover:border-port-accent">
            Clear selection
          </button>
        )}
      </div>

      {selected.length > 0 && <SideBySideTable models={selected} report={report} runtimeLabelFor={runtimeLabelFor} />}

      {showConsent && profile && (
        <BenchmarkConsentModal
          models={selected}
          profile={profile}
          runtimeLabelFor={runtimeLabelFor}
          starting={starting}
          onCancel={() => setShowConsent(false)}
          onConfirm={start}
        />
      )}
    </section>
  );
}
