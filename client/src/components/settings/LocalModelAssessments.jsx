/**
 * Measured local-model assessments.
 *
 * The catalog's fit badge is a size estimate that never runs the model. This
 * panel shows what a model ACTUALLY did on this machine — throughput, TTFT, the
 * largest context it managed, and how much of its peak speed survived to that
 * context — and ranks the assessed models for one of four intents.
 *
 * ## Two rules this panel exists to honour
 *
 * 1. **No cold-bootstrap LLM calls** (root CLAUDE.md). Reading assessments hits
 *    disk only, so it loads with the tab. Running one calls a provider, so it
 *    fires only from an explicit click AND a consent modal that names the
 *    backend, the model, and how many generations are about to happen.
 * 2. **Unknown is not bad.** A model with no evidence is listed under "Not yet
 *    measured" with a Measure button — never ranked last, never shown as a poor
 *    choice. Same for an axis that wasn't measured: it is omitted, not zeroed.
 */

import { useCallback, useEffect, useState } from 'react';
import { Gauge, RefreshCw, Trash2, Play, AlertTriangle } from 'lucide-react';
import Modal from '../ui/Modal';
import BrailleSpinner from '../BrailleSpinner';
import toast from '../ui/Toast';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { formatDurationMs } from '../../utils/formatters';
import {
  getLocalLlmAssessments, runLocalLlmAssessment, deleteLocalLlmAssessment,
} from '../../services/api';

const INTENTS = [
  { id: 'balanced', label: 'Balanced', blurb: 'Even weight on capability, speed, context stability, and memory headroom.' },
  { id: 'smartest', label: 'Smartest', blurb: 'Favors the largest model that actually ran here.' },
  { id: 'fastest', label: 'Fastest', blurb: 'Favors measured throughput above all else.' },
  { id: 'lightweight', label: 'Lightweight', blurb: 'Favors the smallest resident footprint — room left for other work.' },
];

const BACKEND_LABEL = { ollama: 'Ollama', lmstudio: 'LM Studio' };

const VERDICT_META = {
  fits: { label: 'Fits', cls: 'text-emerald-400 border-emerald-400/50' },
  'does-not-fit': { label: 'Does not fit', cls: 'text-port-warning border-port-warning/50' },
  incompatible: { label: 'Incompatible', cls: 'text-port-error border-port-error/50' },
  unknown: { label: 'Unknown', cls: 'text-gray-400 border-gray-500/50' },
};

const AXIS_LABEL = { capability: 'Capability', speed: 'Speed', fidelity: 'Context stability', memory: 'Memory headroom' };

const formatContext = (tokens) => (tokens >= 1024 ? `${Math.round(tokens / 1024)}k` : String(tokens));

// `null` is NOT MEASURED and must render as such — never as 0, and never as a
// dash the reader could mistake for "measured, none".
const Measured = ({ value, suffix = '', digits = 0 }) =>
  (typeof value === 'number' && Number.isFinite(value)
    ? <>{value.toFixed(digits)}{suffix}</>
    : <span className="text-gray-600 italic">not measured</span>);

function VerdictPill({ verdict }) {
  const meta = VERDICT_META[verdict] || VERDICT_META.unknown;
  return (
    <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded border ${meta.cls}`}>{meta.label}</span>
  );
}

// Consent gate. PortOS never calls a provider the user didn't knowingly ask for,
// so this names the exact backend, model, and generation count before the first
// request goes out — the same contract as the POST drill cache's fill modal.
function AssessmentConsentModal({ target, contextTokens, onCancel, onConfirm, running }) {
  if (!target) return null;
  return (
    <Modal open onClose={onCancel} size="sm" ariaLabel="Run local model assessment" closeOnBackdrop={!running}>
      <div className="bg-port-card border border-port-border rounded-lg p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Gauge size={18} className="text-port-accent" />
          <h3 className="text-white font-medium">Measure this model?</h3>
        </div>
        <p className="text-sm text-gray-400">
          PortOS will run <span className="text-gray-200 font-mono break-all">{target.modelId}</span> on{' '}
          <span className="text-gray-200">{BACKEND_LABEL[target.backend] || target.backend}</span>{' '}
          {contextTokens.length} time{contextTokens.length === 1 ? '' : 's'} — one short generation at each of{' '}
          {contextTokens.map(formatContext).join(', ')} tokens of context — and record what it measured.
        </p>
        <p className="text-xs text-gray-500">
          Nothing else on this page calls a model. This can take several minutes on a large model, and it
          loads the model into memory. The result stays on this machine and is never synced to a peer.
        </p>
        <div className="flex gap-3 pt-1">
          <button
            onClick={onCancel}
            disabled={running}
            className="flex-1 px-4 py-2 bg-port-card border border-port-border hover:border-port-accent text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={running}
            className="flex-1 px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-port-on-accent text-sm font-medium rounded-lg transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {running ? <><BrailleSpinner /> Measuring…</> : <>Run assessment</>}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function RankedRow({ entry, onRemeasure, onDelete, busy }) {
  const perf = entry.performance || {};
  return (
    <div className="border border-port-border rounded-lg p-3 space-y-2">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm text-white font-mono break-all">{entry.modelId}</span>
            <span className="text-[10px] text-gray-500">{BACKEND_LABEL[entry.backend] || entry.backend}</span>
            <VerdictPill verdict={entry.verdict} />
          </div>
          <p className="text-xs text-gray-400 mt-1">{entry.explanation}</p>
          {/* The score renormalizes over MEASURED axes, so a model with partial
              evidence can outrank a fully-measured one. Say so rather than
              presenting the rank as though it rested on the same footing. */}
          {Number.isFinite(entry.coverage) && entry.coverage < 1 && (
            <p className="text-[11px] text-gray-500 mt-0.5">
              Ranked on {Math.round(entry.coverage * 100)}% of this intent&apos;s criteria — the rest went unmeasured.
            </p>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => onRemeasure(entry)}
            disabled={busy}
            title="Measure again"
            aria-label={`Measure ${entry.modelId} again`}
            className="p-1.5 text-gray-400 hover:text-white transition-colors disabled:opacity-50"
          >
            <RefreshCw size={13} />
          </button>
          <button
            onClick={() => onDelete(entry)}
            disabled={busy}
            title="Discard this measurement"
            aria-label={`Discard the measurement for ${entry.modelId}`}
            className="p-1.5 text-gray-400 hover:text-port-error transition-colors disabled:opacity-50"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <div>
          <div className="text-gray-500">Throughput</div>
          <div className="text-gray-200"><Measured value={perf.meanCharsPerSecond} suffix=" chars/s" /></div>
        </div>
        <div>
          <div className="text-gray-500">First token</div>
          <div className="text-gray-200">
            {Number.isFinite(perf.meanTtftMs)
              ? formatDurationMs(perf.meanTtftMs)
              : <span className="text-gray-600 italic">not measured</span>}
          </div>
        </div>
        <div>
          <div className="text-gray-500">Max context</div>
          <div className="text-gray-200">
            {Number.isFinite(perf.maxWorkingContextTokens)
              ? `${formatContext(perf.maxWorkingContextTokens)} tokens`
              : <span className="text-gray-600 italic">not measured</span>}
          </div>
        </div>
        <div>
          <div className="text-gray-500">Resident</div>
          <div className="text-gray-200"><Measured value={entry.residentGb} suffix=" GB" digits={1} /></div>
        </div>
      </div>

      {/* Per-axis bars, so the ranking is explainable rather than a bare score.
          An unmeasured axis renders as text, never as an empty bar the reader
          would read as "scored zero". */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] pt-1">
        {Object.entries(AXIS_LABEL).map(([axis, label]) => {
          const value = entry.scores?.[axis];
          return (
            <span key={axis} className="flex items-center gap-1.5">
              <span className="text-gray-500">{label}</span>
              {Number.isFinite(value) ? (
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block w-10 h-1.5 rounded bg-port-border overflow-hidden align-middle">
                    <span className="block h-full bg-port-accent" style={{ width: `${Math.round(value * 100)}%` }} />
                  </span>
                  <span className="text-gray-300">{Math.round(value * 100)}</span>
                </span>
              ) : (
                <span className="text-gray-600 italic">n/a</span>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function LocalModelAssessments() {
  const [intent, setIntent] = useState('balanced');
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [pendingTarget, setPendingTarget] = useState(null);

  const load = useCallback(async (nextIntent) => {
    setLoading(true);
    // The panel owns its own empty/error rendering, so silence the default toast
    // (client/src/CLAUDE.md: custom catch ⇒ silent).
    const data = await getLocalLlmAssessments(nextIntent, { silent: true }).catch(() => null);
    setReport(data);
    setLoading(false);
  }, []);

  useEffect(() => { load(intent); }, [load, intent]);

  const [runAssessment, running] = useAsyncAction(async (target) => {
    const result = await runLocalLlmAssessment(
      { backend: target.backend, modelId: target.modelId },
      { silent: true },
    );
    // Reactive update rather than a refetch of the whole report — except the
    // ranking itself is server-derived, so pull the fresh ranking once the run
    // lands. Keeping the local swap would mean re-implementing the scoring here.
    await load(intent);
    return result;
  }, { errorMessage: 'Assessment failed' });

  const confirmRun = async () => {
    const target = pendingTarget;
    const result = await runAssessment(target);
    setPendingTarget(null);
    if (result) {
      const verdict = VERDICT_META[result.verdict]?.label || result.verdict;
      toast.success(`${target.modelId}: ${verdict}`);
    }
  };

  const [removeAssessment, removing] = useAsyncAction(async (entry) => {
    await deleteLocalLlmAssessment(entry.backend, entry.modelId, { silent: true });
    setReport((prev) => (prev ? {
      ...prev,
      ranked: prev.ranked.filter((r) => !(r.backend === entry.backend && r.modelId === entry.modelId)),
      assessments: prev.assessments.filter((a) => !(a.backend === entry.backend && a.modelId === entry.modelId)),
      unassessed: [...prev.unassessed, { backend: entry.backend, modelId: entry.modelId, params: null }],
    } : prev));
    return true;
  }, { errorMessage: 'Could not discard that measurement' });

  const busy = running || removing;
  const activeIntent = INTENTS.find((i) => i.id === intent);

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6 space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Gauge size={16} className="text-port-accent" />
          <h2 className="text-sm font-medium text-gray-300">Measured Model Assessments</h2>
        </div>
        <button
          onClick={() => load(intent)}
          disabled={loading}
          className="p-1.5 text-gray-400 hover:text-white transition-colors"
          title="Refresh"
          aria-label="Refresh model assessments"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <p className="text-xs text-gray-500">
        The install catalog estimates fit from a model&apos;s file size. This measures it: one short
        generation at each of several context lengths, recording throughput, time to first token, and how
        far throughput falls off as context grows. Results stay on this machine — they describe this
        hardware, so they are never synced to a peer.
      </p>

      <div className="flex items-center gap-2 flex-wrap">
        <label htmlFor="assessment-intent" className="text-xs text-gray-400">Rank for</label>
        <select
          id="assessment-intent"
          value={intent}
          onChange={(e) => setIntent(e.target.value)}
          className="bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-white"
        >
          {INTENTS.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
        </select>
        <span className="text-xs text-gray-500">{activeIntent?.blurb}</span>
      </div>

      {loading && !report ? (
        <BrailleSpinner text="Loading assessments" />
      ) : !report ? (
        <p className="text-xs text-gray-500">Could not load assessments. Use Refresh to try again.</p>
      ) : (
        <>
          {report.readError && (
            <p className="text-xs text-port-warning flex items-center gap-1.5" role="alert">
              <AlertTriangle size={12} /> {report.readError} — the next assessment will start a fresh record.
            </p>
          )}
          {report.listErrors?.length > 0 && (
            <p className="text-xs text-port-warning flex items-center gap-1.5" role="alert">
              <AlertTriangle size={12} />
              Could not list installed models for {report.listErrors.map((b) => BACKEND_LABEL[b] || b).join(' and ')} —
              models there may be missing from this list.
            </p>
          )}

          {report.ranked.length > 0 ? (
            <div className="space-y-2">
              {report.ranked.map((entry) => (
                <RankedRow
                  key={`${entry.backend}:${entry.modelId}`}
                  entry={entry}
                  busy={busy}
                  onRemeasure={setPendingTarget}
                  onDelete={removeAssessment}
                />
              ))}
            </div>
          ) : (
            <p className="text-xs text-gray-500">
              Nothing measured yet. Pick a model below and run an assessment to see how it actually
              performs here.
            </p>
          )}

          {report.excluded?.length > 0 && (
            <div className="space-y-1">
              <h3 className="text-xs font-medium text-gray-400">Measured, but not recommended</h3>
              {report.excluded.map((entry) => (
                <div key={`${entry.backend}:${entry.modelId}`} className="flex items-center gap-2 text-xs flex-wrap">
                  <span className="text-gray-300 font-mono break-all">{entry.modelId}</span>
                  <VerdictPill verdict={entry.verdict} />
                  {entry.reason && <span className="text-gray-500">{entry.reason}</span>}
                </div>
              ))}
            </div>
          )}

          {report.unassessed?.length > 0 && (
            <div className="space-y-1">
              <h3 className="text-xs font-medium text-gray-400">
                Not yet measured ({report.unassessed.length})
              </h3>
              <p className="text-[11px] text-gray-500">
                No evidence recorded — that is not a mark against them, just an unanswered question.
              </p>
              <div className="space-y-1 pt-1">
                {report.unassessed.map((entry) => (
                  <div key={`${entry.backend}:${entry.modelId}`} className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-gray-300 font-mono break-all min-w-0">
                      {entry.modelId}
                      <span className="text-gray-600 ml-2">{BACKEND_LABEL[entry.backend] || entry.backend}</span>
                    </span>
                    <button
                      onClick={() => setPendingTarget(entry)}
                      disabled={busy}
                      className="flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-port-border text-gray-300 hover:border-port-accent hover:text-white transition-colors disabled:opacity-50 shrink-0"
                    >
                      <Play size={11} /> Measure
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <AssessmentConsentModal
        target={pendingTarget}
        contextTokens={report?.defaultContextTokens || []}
        running={running}
        onCancel={() => (running ? null : setPendingTarget(null))}
        onConfirm={confirmRun}
      />
    </div>
  );
}

export default LocalModelAssessments;
