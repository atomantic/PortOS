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
 *    backend, the model, and how many generations are about to happen. The
 *    batch run (`AssessmentSweepPanel`) is held to exactly the same gate.
 * 2. **Unknown is not bad.** A model with no evidence is listed under "Not yet
 *    measured" with a Measure button — never ranked last, never shown as a poor
 *    choice. Same for an axis that wasn't measured: it is omitted, not zeroed.
 *
 * Throughput is reported in tokens/s wherever the runtime reported token counts,
 * with chars/s as the universal fallback — `ModelThroughputReport` is the full
 * per-context table. PortOS never derives one unit from the other.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Gauge, RefreshCw, Trash2, Play, AlertTriangle, History, SlidersHorizontal, ChevronDown, ChevronUp, Terminal } from 'lucide-react';
import socket from '../../services/socket';
import Drawer from '../Drawer';
import BrailleSpinner from '../BrailleSpinner';
import toast from '../ui/Toast';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import useMounted from '../../hooks/useMounted';
import useUrlParams from '../../hooks/useUrlParams';
import AssessmentSweepPanel from './AssessmentSweepPanel';
import ModelThroughputReport from './ModelThroughputReport';
import { formatContextTokens, formatDurationMs, throughputLabel } from '../../utils/formatters';
import { tuningNoticeChip } from '../../lib/assessmentTuningNotice';
import {
  getLocalLlmAssessments, runLocalLlmAssessment, runOpenCodeAgentBenchmark, deleteLocalLlmAssessment,
} from '../../services/api';

const INTENTS = [
  { id: 'balanced', label: 'Balanced', blurb: 'Even weight on capability, speed, context stability, and memory headroom.' },
  { id: 'smartest', label: 'Smartest', blurb: 'Favors the largest model that actually ran here.' },
  { id: 'fastest', label: 'Fastest', blurb: 'Favors measured throughput above all else.' },
  { id: 'lightweight', label: 'Lightweight', blurb: 'Favors the smallest resident footprint — room left for other work.' },
];

// Fallback labels only. The authoritative roster (label, reachability, knob
// catalog) rides on the report as `runtimes` — a hardcoded list here would drift
// the moment the server learns a sixth runtime.
const BACKEND_LABEL = {
  ollama: 'Ollama', lmstudio: 'LM Studio', llama: 'llama.cpp', mtplx: 'MTPLX', vllm: 'vLLM',
};

const OPENCODE_AGENT_TARGETS = [
  { backend: 'llama', label: 'OpenCode llama TUI', modelId: 'qwen3.8-27b-dflash2' },
  { backend: 'mtplx', label: 'OpenCode MTPLX TUI', modelId: 'mtplx-qwen38-27b-optimized-speed' },
  { backend: 'ollama', label: 'OpenCode Ollama TUI', modelId: 'qwen3.8:27b-mlx' },
];

const VERDICT_META = {
  fits: { label: 'Fits', cls: 'text-emerald-400 border-emerald-400/50' },
  'does-not-fit': { label: 'Does not fit', cls: 'text-port-warning border-port-warning/50' },
  incompatible: { label: 'Incompatible', cls: 'text-port-error border-port-error/50' },
  unknown: { label: 'Unknown', cls: 'text-gray-400 border-gray-500/50' },
};

const AXIS_LABEL = { capability: 'Capability', speed: 'Speed', fidelity: 'Context stability', memory: 'Memory headroom' };

const backendLabel = (report, id) =>
  report?.runtimes?.find((r) => r.id === id)?.label || BACKEND_LABEL[id] || id;

const specsFor = (report, id) => report?.runtimes?.find((r) => r.id === id)?.tuningSpecs || [];

// The tuning grid a sweep of this runtime would run, straight from the server —
// so the consent gate's count is the count that executes. Fewer than two entries
// means a sweep is not on offer: either the runtime declares no sweepable knob,
// or PortOS cannot reset it and put it back afterwards, and the server says so
// by shipping an empty grid. Either way the button stays off rather than
// advertising a comparison that would not be valid.
const gridFor = (report, id) => report?.runtimes?.find((r) => r.id === id)?.tuningGrid || [];

// An empty field means "leave the daemon on its own default", so it is dropped
// rather than sent as 0/false — the server applies the same rule.
const compactTuning = (draft) => Object.fromEntries(
  Object.entries(draft || {}).filter(([, v]) => v !== '' && v !== null && v !== undefined)
);

// A model can hold several measurements, one per launch tuning, so the tuning is
// part of a row's identity — not decoration. Keying on model alone gave two
// variants the same React key and made "discard" target the wrong record.
//
// `modelKey` is the coarser identity a TUNING SWEEP works in: a sweep is what
// measures the tunings, so it targets the model rather than one of its recorded
// configurations.
const modelKey = (entry) => `${entry.backend}:${entry.modelId}`;
const entryKey = (entry) => `${modelKey(entry)}@${entry.tuningKey || ''}`;

// Which model the measure drawer has open lives in the URL, not in local state,
// so the gate is shareable, bookmarkable and reload-safe — the same rule the
// AI-provider editor follows at /ai/edit/:providerId. Search params rather than
// a path segment because a model id is not one: it carries `/` and `:`
// (`hf.co/org/repo:Q4_K_M`), and the drawer is an overlay on an already-routed
// tab. `measureTuning` is the tuning key of the record being re-measured, so a
// deep link reopens the configuration it describes rather than the defaults.
const CLOSED_MEASURE_PARAMS = { measureBackend: null, measureModel: null, measureTuning: null };

// Its neighbour on the same row — the per-model "Sweep tunings" gate — is
// routable for the same reasons and by the same mechanism. It names no tuning:
// the sweep is what measures the tunings, so the model is the whole target, and
// everything else the gate shows (the runtime label, the grid it will run) is
// derivable from that pair plus the report.
const CLOSED_SWEEP_PARAMS = { sweepBackend: null, sweepModel: null };

// Dismissing either gate clears BOTH targets. Only a hand-edited link can name
// both at once, and having one gate close straight into the other would read as
// the dismissal not having worked.
const CLOSED_GATE_PARAMS = { ...CLOSED_MEASURE_PARAMS, ...CLOSED_SWEEP_PARAMS };

// `null` is NOT MEASURED and must render as such — never as 0, and never as a
// dash the reader could mistake for "measured, none".
const Measured = ({ value, suffix = '', digits = 0 }) =>
  (typeof value === 'number' && Number.isFinite(value)
    ? <>{value.toFixed(digits)}{suffix}</>
    : <span className="text-gray-600 italic">not measured</span>);

// A measurement only describes the machine it was taken on. When the recorded
// environment no longer matches the live one — a RAM upgrade, a backend update —
// the reading is silently misleading, and nothing else on this page would say so.
function StalePill({ staleness }) {
  if (!staleness?.stale) return null;
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded border text-port-warning border-port-warning/50"
      title={staleness.description || 'Measured on a different machine state.'}
    >
      <History size={9} /> stale
    </span>
  );
}

function VerdictPill({ verdict }) {
  const meta = VERDICT_META[verdict] || VERDICT_META.unknown;
  return (
    <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded border ${meta.cls}`}>{meta.label}</span>
  );
}

/**
 * One runtime's tuning knobs as a form.
 *
 * Every field starts EMPTY, which means "leave the daemon on its own default" —
 * not zero. Pre-filling a number would silently pin a value the user never
 * chose and make two "default" readings incomparable.
 */
function TuningFields({ specs, draft, onChange, disabled }) {
  if (!specs.length) return null;
  const set = (id, value) => onChange({ ...draft, [id]: value });
  return (
    <div className="space-y-2">
      {specs.map((spec) => {
        const fieldId = `tuning-${spec.id}`;
        const value = draft[spec.id] ?? '';
        return (
          <div key={spec.id} className="grid grid-cols-[1fr_auto] gap-2 items-start">
            <div className="min-w-0">
              <label htmlFor={fieldId} className="text-xs text-gray-300">{spec.label}</label>
              <p className="text-[10px] text-gray-500 leading-snug">{spec.hint}</p>
              {/* What PortOS will DO with the knob, naming the flag or variable
                  it becomes. Derived server-side from the knob's transport
                  (server/lib/localModelTuning.js) and shipped on the spec, so
                  the UI cannot describe a transport differently from the code
                  that applies it. */}
              <p className="text-[10px] text-gray-600 leading-snug">{spec.note}</p>
            </div>
            {spec.type === 'boolean' ? (
              <input
                id={fieldId}
                type="checkbox"
                disabled={disabled}
                checked={value === true}
                onChange={(e) => set(spec.id, e.target.checked ? true : '')}
                className="mt-1 accent-port-accent"
              />
            ) : spec.type === 'enum' ? (
              <select
                id={fieldId}
                disabled={disabled}
                value={value}
                onChange={(e) => set(spec.id, e.target.value)}
                className="bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-white w-28"
              >
                <option value="">default</option>
                {spec.options.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : (
              <input
                id={fieldId}
                type="number"
                inputMode="decimal"
                disabled={disabled}
                min={spec.min}
                max={spec.max}
                step={spec.step || 1}
                placeholder="default"
                value={value}
                onChange={(e) => set(spec.id, e.target.value === '' ? '' : Number(e.target.value))}
                className="bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-white w-28"
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// Consent gate. PortOS never calls a provider the user didn't knowingly ask for,
// so this names the exact backend, model, and generation count before the first
// request goes out — the same contract as the POST drill cache's fill modal.
//
// Routable rather than modal — see CLOSED_MEASURE_PARAMS above for why the open
// target lives in the URL.
function AssessmentDrawer({
  target, unknownTarget, runtimeLabel, contextTokens, tuningSpecs, tuning, onTuningChange,
  onClose, onConfirm, running, progress,
}) {
  const [showTuning, setShowTuning] = useState(false);
  if (!target) return null;
  const tunedCount = Object.keys(compactTuning(tuning)).length;
  return (
    <Drawer
      open
      onClose={onClose}
      title="Measure this model"
      subtitle={target.modelId}
      size="md"
      // Closing IS stopping — the close button aborts the run in flight — so
      // both accidental-dismissal paths are shut off while one is working, and
      // the icon-only close button says what it will actually do.
      closeLabel={running ? 'Stop the assessment' : 'Close'}
      closeOnEsc={!running}
      closeOnBackdrop={!running}
    >
      <div className="space-y-4">
        {unknownTarget && (
          <p className="text-xs text-port-warning flex items-start gap-1.5" role="alert">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            This model is not in the current list — it may have been removed since the link was made.
            Running it will still ask {runtimeLabel} for it.
          </p>
        )}
        <p className="text-sm text-gray-400">
          PortOS will run <span className="text-gray-200 font-mono break-all">{target.modelId}</span> on{' '}
          <span className="text-gray-200">{runtimeLabel}</span>{' '}
          {contextTokens.length} time{contextTokens.length === 1 ? '' : 's'} — one short generation at each of{' '}
          {contextTokens.map(formatContextTokens).join(', ')} tokens of context — and record what it measured.
        </p>
        <p className="text-xs text-gray-500">
          Nothing else on this page calls a model. This can take several minutes on a large model, and it
          loads the model into memory. The result stays on this machine and is never synced to a peer.
        </p>

        {/* Tuning is opt-in and collapsed: the common case is "measure it as it
            is", and an expanded knob wall would make that click look risky. A
            tuned run is stored as its OWN record, so it never overwrites the
            defaults reading it should be compared against. */}
        {tuningSpecs.length > 0 && (
          <div className="border border-port-border rounded-lg">
            <button
              type="button"
              onClick={() => setShowTuning((v) => !v)}
              disabled={running}
              aria-expanded={showTuning}
              className="w-full flex items-center justify-between gap-2 px-3 py-2 text-xs text-gray-300 hover:text-white transition-colors disabled:opacity-50"
            >
              <span className="flex items-center gap-1.5">
                <SlidersHorizontal size={12} />
                Tuning {tunedCount > 0 && <span className="text-port-accent">({tunedCount} set)</span>}
              </span>
              {showTuning ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>
            {showTuning && (
              <div className="px-3 pb-3 space-y-2">
                <p className="text-[10px] text-gray-500">
                  Leave a field empty to use the runtime&apos;s own default. A tuned run is recorded
                  separately, so you can compare it against the untuned one instead of replacing it.
                  Setting a launch knob restarts that runtime&apos;s server before measuring, which
                  interrupts anything else using it.
                </p>
                <TuningFields specs={tuningSpecs} draft={tuning} onChange={onTuningChange} disabled={running} />
              </div>
            )}
          </div>
        )}
        {/* Live per-sample progress off the `localLlm:progress` socket event, so a
            multi-minute run reports which sample it is on instead of a bare spinner.
            Absent until the first frame arrives — never a fake 0%. */}
        {running && progress && (
          <div className="space-y-1" aria-live="polite">
            {Number.isFinite(progress.sampleCount) && progress.sampleCount > 0 && (
              <div className="h-1 rounded bg-port-border overflow-hidden">
                <div
                  className="h-full bg-port-accent transition-all"
                  style={{ width: `${Math.round((Math.min(progress.sampleIndex ?? 0, progress.sampleCount) / progress.sampleCount) * 100)}%` }}
                />
              </div>
            )}
            <p className="text-[11px] text-gray-400 break-words">{progress.message}</p>
          </div>
        )}
        <div className="flex gap-3 pt-1">
          {/* Stays enabled while the run is in flight — it aborts the request
              rather than merely closing the drawer, so the user is never stuck
              watching a multi-minute job they no longer want. */}
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 bg-port-card border border-port-border hover:border-port-accent text-white text-sm font-medium rounded-lg transition-colors"
          >
            {running ? 'Stop' : 'Cancel'}
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
    </Drawer>
  );
}

function RankedRow({ entry, runtimeLabel, onRemeasure, onDelete, onSweepTunings, sweepVariants, busy }) {
  const perf = entry.performance || {};
  return (
    <div className="border border-port-border rounded-lg p-3 space-y-2">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm text-white font-mono break-all">{entry.modelId}</span>
            <span className="text-[10px] text-gray-500">{runtimeLabel}</span>
            <VerdictPill verdict={entry.verdict} />
            <StalePill staleness={entry.staleness} />
            {/* Which launch configuration this reading describes. Shown even for
                an untuned run: "backend defaults" is a real answer, and leaving
                it blank would read as "unknown configuration". */}
            <span className="px-1.5 py-0.5 text-[10px] rounded border border-port-border text-gray-400">
              {entry.tuningLabel || 'backend defaults'}
            </span>
          </div>
          {/* No `tuningApplied === false` caveat here on purpose: a reading whose
              configuration never reached the daemon is never RANKED. The server
              pulls it out of `scorable` and into `excluded`, which renders the
              reason below — see `getAssessmentReport`. */}
          <p className="text-xs text-gray-400 mt-1">{entry.explanation}</p>
          {entry.staleness?.stale && (
            <p className="text-[11px] text-port-warning mt-0.5">
              {entry.staleness.description} Measure again to refresh it.
            </p>
          )}
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
            title="Measure again (and adjust tuning)"
            aria-label={`Measure ${entry.modelId} again`}
            className="p-1.5 text-gray-400 hover:text-white transition-colors disabled:opacity-50"
          >
            <RefreshCw size={13} />
          </button>
          {/* Only offered where the runtime declares a knob worth varying —
              a one-entry grid is the baseline alone, which `compareTunings`
              cannot rank against anything. */}
          {sweepVariants > 1 && (
            <button
              onClick={() => onSweepTunings(entry)}
              disabled={busy}
              title={`Measure this model under ${sweepVariants} launch configurations and rank them`}
              aria-label={`Sweep tunings for ${entry.modelId}`}
              className="p-1.5 text-gray-400 hover:text-white transition-colors disabled:opacity-50"
            >
              <SlidersHorizontal size={13} />
            </button>
          )}
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
          {/* Tokens/s where the runtime reported token counts — the figure people
              compare local models on — with chars/s underneath as the universal
              one. A runtime that reports no usage shows chars/s alone rather than
              a tokens/s figure divided out of it. */}
          <div className="text-gray-200">
            {throughputLabel(perf) || <span className="text-gray-600 italic">not measured</span>}
            {Number.isFinite(perf.meanTokensPerSecond) && (
              <span className="text-gray-600 ml-1.5 text-[10px]">
                <Measured value={perf.meanCharsPerSecond} suffix=" chars/s" />
              </span>
            )}
          </div>
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
              ? `${formatContextTokens(perf.maxWorkingContextTokens)} tokens`
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

/**
 * Which launch tuning won, per model.
 *
 * Only rendered for models measured under two or more tunings — one reading is
 * not a comparison, and presenting it as "the best tuning" would dress a single
 * measurement up as a conclusion. The server enforces the same rule.
 */
function TuningComparison({ rows, runtimeLabelFor }) {
  if (!rows?.length) return null;
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-medium text-gray-400">Tuning comparison</h3>
      <p className="text-[11px] text-gray-500">
        Throughput of each launch configuration, relative to the best one measured for that model.
        The comparison uses exact tokens/s when every variant reports tokenizer counts; otherwise it
        uses chars/s so estimates and missing usage do not decide the winner.
      </p>
      {rows.map((row) => (
        <div key={`${row.backend}:${row.modelId}`} className="border border-port-border rounded-lg p-3 space-y-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-white font-mono break-all">{row.modelId}</span>
            <span className="text-[10px] text-gray-500">{runtimeLabelFor(row.backend)}</span>
          </div>
          {row.variants.map((variant, index) => (
            <div key={`${row.backend}:${row.modelId}@${variant.label}`} className="grid grid-cols-[1fr_auto] gap-2 items-center text-[11px]">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className={index === 0 ? 'text-emerald-400' : 'text-gray-300'}>{variant.label}</span>
                  {index === 0 && <span className="text-[10px] text-emerald-400/70">best</span>}
                </div>
                <span className="inline-block w-full max-w-[220px] h-1.5 rounded bg-port-border overflow-hidden align-middle">
                  <span
                    className={`block h-full ${index === 0 ? 'bg-emerald-400' : 'bg-port-accent'}`}
                    style={{ width: `${Math.max(2, Math.round(variant.deltaPercent ?? 0))}%` }}
                  />
                </span>
              </div>
              <div className="text-right text-gray-400 shrink-0">
                {Number.isFinite(variant.rate)
                  ? `${variant.rate} ${row.metricLabel || (row.metric === 'tokensPerSecond' ? 'tokens/s' : 'chars/s')}`
                  : 'not measured'}
                <span className="text-gray-600 ml-1.5">{variant.deltaPercent}%</span>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * Every runtime PortOS can measure against, and whether it can be reached.
 *
 * `modelCount === null` means the listing FAILED, so the count is unknown — a
 * stopped daemon must not render as "0 models", which reads as "nothing
 * installed" when the fix is to start it.
 */
function RuntimeRoster({ runtimes }) {
  if (!runtimes?.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {runtimes.map((runtime) => (
        <span
          key={runtime.id}
          title={runtime.error || undefined}
          className={`px-1.5 py-0.5 text-[10px] rounded border ${
            runtime.error ? 'text-gray-500 border-port-border' : 'text-gray-300 border-port-accent/40'
          }`}
        >
          {runtime.label}
          <span className="ml-1 text-gray-600">
            {runtime.modelCount === null ? 'unreachable' : `${runtime.modelCount} model${runtime.modelCount === 1 ? '' : 's'}`}
          </span>
        </span>
      ))}
    </div>
  );
}

function OpenCodeAgentBenchmarkPanel({ results, running, onRun }) {
  const completed = OPENCODE_AGENT_TARGETS
    .map((target) => ({ target, result: results?.[target.backend] }))
    .filter(({ result }) => result?.completed);
  const comparableTokens = completed.length > 0
    && completed.every(({ result }) => Number.isFinite(result.taskTokensPerSecond));
  const metricKey = comparableTokens ? 'taskTokensPerSecond' : 'taskCharsPerSecond';
  const metricLabel = comparableTokens ? 'tok/s' : 'chars/s';
  const leader = [...completed]
    .filter(({ result }) => Number.isFinite(result[metricKey]))
    .sort((a, b) => b.result[metricKey] - a.result[metricKey])[0];

  return (
    <div className="border border-port-border rounded-lg p-3 space-y-2">
      <div className="flex items-center gap-1.5 text-xs text-gray-300">
        <Terminal size={12} className="text-port-accent" />
        <h3 className="font-medium">OpenCode agent-task check</h3>
      </div>
      <p className="text-[11px] text-gray-500">
        Runs one disposable task through each configured OpenCode local preset. The agent must create and
        read a sentinel file in a temporary workspace, so this measures tool-loop completion rather than raw
        decoder speed. Terminal paste/render overhead is intentionally excluded; compare the direct report
        above for engine throughput.
      </p>
      {leader && (
        <div className="text-[11px] text-port-accent border border-port-accent/30 rounded px-2 py-1">
          Current task leader: <span className="font-medium">{leader.target.label}</span> — {leader.result[metricKey]} {metricLabel}
          {comparableTokens ? ' (exact OpenCode output counts)' : ' (chars/s fallback until every check reports tokens)'}
        </div>
      )}
      <div className="grid gap-1.5 sm:grid-cols-3">
        {OPENCODE_AGENT_TARGETS.map((target) => {
          const result = results?.[target.backend];
          return (
            <div key={target.backend} className="border border-port-border/70 rounded p-2 space-y-1.5">
              <div className="text-[11px] text-gray-300">{target.label}</div>
              <div className="text-[10px] text-gray-500 font-mono break-all">{target.modelId}</div>
              {result && (
                <div className={`text-[10px] ${result.completed ? 'text-emerald-400' : 'text-port-warning'}`}>
                  {result.completed ? 'sentinel complete' : (result.error || 'task failed')}
                </div>
              )}
              {result?.completed && (
                <div className="text-[10px] text-gray-400 space-y-0.5">
                  <div>{Number.isFinite(result.taskTokensPerSecond) ? `${result.taskTokensPerSecond} tok/s · ` : ''}{Number.isFinite(result.taskCharsPerSecond) ? `${result.taskCharsPerSecond} chars/s` : 'chars/s n/a'}</div>
                  <div>{result.toolCalls} tool call{result.toolCalls === 1 ? '' : 's'} · {formatDurationMs(result.elapsedMs)}</div>
                </div>
              )}
              <button
                type="button"
                onClick={() => onRun(target)}
                disabled={running}
                className="w-full flex items-center justify-center gap-1 px-2 py-1 text-[10px] rounded border border-port-border text-gray-300 hover:border-port-accent hover:text-white transition-colors disabled:opacity-50"
              >
                <Play size={10} /> {running ? 'Running…' : 'Run task check'}
              </button>
            </div>
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
  // The knobs the user has typed, or `null` while they have typed nothing — in
  // which case the form shows the tuning of the record the URL names, so
  // re-measuring reproduces that configuration and adjusting one knob is a
  // one-field edit. Deriving it (rather than seeding a state copy) is what lets
  // a cold deep link pick the record up the moment the report lands, while a
  // background refresh can never overwrite a half-typed value.
  const [tuningEdits, setTuningEdits] = useState(null);
  // Per-sample progress for the run in flight. `null` = no frame yet, which is
  // rendered as "no progress bar" rather than as 0 of N.
  const [progress, setProgress] = useState(null);
  // Whether the server-side sweep is working. Owned here rather than in the
  // sweep panel because it gates this panel's per-model buttons too.
  const [sweepRunning, setSweepRunning] = useState(false);
  const [agentBenchmarkResults, setAgentBenchmarkResults] = useState({});

  const [searchParams, updateParams] = useUrlParams();
  const measureBackend = searchParams.get('measureBackend') || '';
  const measureModel = searchParams.get('measureModel') || '';
  const measureTuning = searchParams.get('measureTuning') || '';
  const sweepBackend = searchParams.get('sweepBackend') || '';
  const sweepModel = searchParams.get('sweepModel') || '';

  // The two gates are alternatives, not siblings — both hold the provider, and
  // only one is reachable by clicking. Each open therefore drops the other's
  // params, so the URL never carries a target for a gate that is not on screen.
  // (What GUARANTEES one drawer is the precedence rule further down, not this.)
  const openTarget = useCallback((entry) => updateParams({
    ...CLOSED_SWEEP_PARAMS,
    measureBackend: entry.backend,
    measureModel: entry.modelId,
    measureTuning: entry.tuningKey || null,
  }), [updateParams]);

  // `replace` so closing the drawer doesn't leave a Back button that reopens it
  // on a run the user just cancelled.
  const closeTarget = useCallback(() => {
    updateParams(CLOSED_GATE_PARAMS, { replace: true });
    setTuningEdits(null);
  }, [updateParams]);

  // Names the model for the sweep panel's consent gate — that panel owns the
  // gate and the progress for BOTH sweeps, because there is only one
  // server-side queue and so only one place that may render a Stop button.
  const openSweepTarget = useCallback((entry) => updateParams({
    ...CLOSED_MEASURE_PARAMS,
    sweepBackend: entry.backend,
    sweepModel: entry.modelId,
  }), [updateParams]);

  const closeSweepTarget = useCallback(
    () => updateParams(CLOSED_GATE_PARAMS, { replace: true }),
    [updateParams],
  );

  const load = useCallback(async (nextIntent) => {
    setLoading(true);
    // The panel owns its own empty/error rendering, so silence the default toast
    // (client/src/CLAUDE.md: custom catch ⇒ silent).
    const data = await getLocalLlmAssessments(nextIntent, { silent: true }).catch(() => null);
    setReport(data);
    setLoading(false);
  }, []);

  useEffect(() => { load(intent); }, [load, intent]);

  // The row the URL names, once the report can say which one it is — that record
  // is what carries the tuning a re-measure starts from. Matched through
  // `entryKey` so "the same measurement" has one definition, not two.
  const measureMatch = useMemo(() => {
    if (!measureBackend || !measureModel) return null;
    const wanted = entryKey({ backend: measureBackend, modelId: measureModel, tuningKey: measureTuning });
    const hit = (rows) => rows?.find((entry) => entryKey(entry) === wanted);
    return hit(report?.ranked) || hit(report?.excluded) || hit(report?.unassessed) || null;
  }, [report, measureBackend, measureModel, measureTuning]);

  // An id the report doesn't list still opens the drawer — the URL is the source
  // of truth for what's open — and says so, rather than bouncing: the same id is
  // legitimately absent for the moment between a first run landing and the
  // refreshed report arriving, which is why the notice also stands down mid-run.
  const measureOpen = Boolean(measureBackend && measureModel);
  const pendingTarget = measureOpen
    ? measureMatch || { backend: measureBackend, modelId: measureModel, tuningKey: measureTuning }
    : null;
  const recordTuning = measureMatch?.tuning;
  const tuningDraft = tuningEdits
    ?? (recordTuning && typeof recordTuning === 'object' ? recordTuning : {});

  // The sweep gate's whole payload, derived from the model pair in the URL plus
  // the report — the runtime label and the grid are the server's own, never
  // carried in the link, so a shared link describes what would run TODAY.
  //
  // The row is matched through `modelKey`, not `entryKey`: a sweep varies the
  // tuning, so a model with three recorded configurations is still one sweep
  // target, not three. A pair the report no longer lists still opens the gate —
  // the URL is the source of truth for what's open — and says so, the same as
  // the measure drawer; with no grid behind it, Start is already off anyway.
  //
  // The measure drawer wins when a hand-edited link names both: a Drawer assumes
  // it is the only one open (one scroll lock, one focus trap), and the measure
  // gate is the one that can be mid-run.
  const tuningSweepRequest = useMemo(() => {
    if (!sweepBackend || !sweepModel || measureOpen) return null;
    const wanted = modelKey({ backend: sweepBackend, modelId: sweepModel });
    const hit = (rows) => rows?.find((entry) => modelKey(entry) === wanted);
    const listed = Boolean(hit(report?.ranked) || hit(report?.excluded) || hit(report?.unassessed));
    return {
      backend: sweepBackend,
      modelId: sweepModel,
      runtimeLabel: backendLabel(report, sweepBackend),
      variants: gridFor(report, sweepBackend),
      unknownTarget: Boolean(report) && !listed,
    };
  }, [report, sweepBackend, sweepModel, measureOpen]);

  // Which model this panel is currently measuring. A ref, not state: the socket
  // handler subscribes once and must read the CURRENT target, not the one
  // captured when it was registered.
  const activeTargetRef = useRef(null);
  // Re-arms on every mount, so StrictMode's dev mount→cleanup→mount cycle does
  // not leave the panel permanently deaf to progress frames.
  const mountedRef = useMounted();

  // A run is one blocking POST, so without this the UI shows a spinner for
  // minutes. The server streams per-sample frames over the same
  // `localLlm:progress` event model pulls and migrations use — hence the strict
  // filtering below, or a background model download would drive this bar.
  useEffect(() => {
    const handleProgress = (frame) => {
      if (!mountedRef.current) return;
      if (frame?.scope !== 'assessment') return;
      const target = activeTargetRef.current;
      // Frames for a model this panel is not measuring (another tab measuring
      // something else, a run the user already cancelled) are dropped rather
      // than rendered — a stale message is worse than none.
      if (!target || frame.backend !== target.backend || frame.modelId !== target.modelId) return;
      if (frame.event === 'complete') { setProgress(null); return; }
      setProgress({
        message: frame.message || '',
        sampleIndex: Number.isFinite(frame.sampleIndex) ? frame.sampleIndex : null,
        sampleCount: Number.isFinite(frame.sampleCount) ? frame.sampleCount : null,
      });
    };
    socket.on('localLlm:progress', handleProgress);
    return () => socket.off('localLlm:progress', handleProgress);
  }, []);

  // A run occupies the local provider for minutes. Without an abort, leaving
  // the page (or changing your mind) leaves it running with nobody listening —
  // the server drops the assessment on an aborted signal rather than recording a
  // cancel as a `does-not-fit`.
  const runControllerRef = useRef(null);
  useEffect(() => () => runControllerRef.current?.abort(), []);

  const [runAssessment, running] = useAsyncAction(async (target) => {
    const controller = new AbortController();
    runControllerRef.current = controller;
    // An aborted fetch rejects with the generic "Server unreachable" message.
    // That is OUR abort, not a failure, so swallow it here rather than letting
    // useAsyncAction toast an error the user just asked for.
    const result = await runLocalLlmAssessment(
      { backend: target.backend, modelId: target.modelId, tuning: compactTuning(target.tuning) },
      { silent: true, signal: controller.signal },
    ).catch((err) => {
      if (controller.signal.aborted) return { cancelled: true };
      throw err;
    }).finally(() => { runControllerRef.current = null; });
    // The ranking is server-derived, so pull the fresh report once a run lands
    // rather than re-implementing the scoring here. A cancelled run recorded
    // nothing, so there is nothing new to fetch.
    if (!result?.cancelled) await load(intent);
    return result;
  }, { errorMessage: 'Assessment failed' });

  const confirmRun = async () => {
    const target = {
      backend: pendingTarget.backend,
      modelId: pendingTarget.modelId,
      tuning: compactTuning(tuningDraft),
    };
    activeTargetRef.current = target;
    setProgress(null);
    const result = await runAssessment(target);
    activeTargetRef.current = null;
    setProgress(null);
    closeTarget();
    // An aborted run recorded nothing on either side, so there is no verdict to
    // report — marked `cancelled` by the abort catch above, or by the server
    // when it saw the signal drop mid-run.
    if (result && !result.cancelled) {
      const verdict = VERDICT_META[result.verdict]?.label || result.verdict;
      // A tuning that could not be applied means the verdict describes a
      // different configuration — surface that at the point of the result
      // rather than only in the row the user has to go find.
      if (tuningNoticeChip(result)) {
        toast.warning(`${target.modelId}: ${verdict} — ${tuningNoticeChip(result)} (${result.tuningNotApplied || 'reason not recorded'})`);
        return;
      }
      toast.success(`${target.modelId}: ${verdict}`);
    }
  };

  const [removeAssessment, removing] = useAsyncAction(async (entry) => {
    const tuningKey = entry.tuningKey || '';
    await deleteLocalLlmAssessment(entry.backend, entry.modelId, tuningKey, { silent: true });
    const isDropped = (r) => r.backend === entry.backend && r.modelId === entry.modelId && (r.tuningKey || '') === tuningKey;
    setReport((prev) => {
      if (!prev) return prev;
      const assessments = prev.assessments.filter((a) => !isDropped(a));
      // The model only returns to "not yet measured" when its LAST tuning is
      // gone — dropping one of several still leaves evidence for it.
      const stillMeasured = assessments.some((a) => a.backend === entry.backend && a.modelId === entry.modelId);
      return {
        ...prev,
        ranked: prev.ranked.filter((r) => !isDropped(r)),
        assessments,
        unassessed: stillMeasured
          ? prev.unassessed
          : [...prev.unassessed, { backend: entry.backend, modelId: entry.modelId, params: null }],
      };
    });
    return true;
  }, { errorMessage: 'Could not discard that measurement' });

  const [runAgentBenchmark, agentBenchmarkRunning] = useAsyncAction(async (target) => {
    const result = await runOpenCodeAgentBenchmark({ backend: target.backend, modelId: target.modelId });
    setAgentBenchmarkResults((previous) => ({ ...previous, [target.backend]: result }));
    if (result?.completed) {
      toast.success(`${target.label}: agent task completed`);
    } else if (result) {
      toast.warning(`${target.label}: ${result.error || 'agent task did not complete'}`);
    }
    return result;
  }, { errorMessage: 'OpenCode agent benchmark failed' });

  const cancelRun = () => {
    runControllerRef.current?.abort();
    // Stop accepting frames for the abandoned run BEFORE the drawer closes, or a
    // late frame would repopulate a progress bar with nothing behind it.
    activeTargetRef.current = null;
    setProgress(null);
    closeTarget();
  };

  // A sweep holds the provider for hours. A single-model run started on top of
  // it would measure the contention between the two, so every per-model action
  // goes quiet while the queue is working.
  // O(1) label lookup with a stable identity: the throughput table calls it once
  // per row, and a fresh closure each render would forbid ever memoizing that
  // table. The report's roster is authoritative; BACKEND_LABEL is the fallback.
  const runtimeLabelFor = useCallback(
    (id) => report?.runtimes?.find((r) => r.id === id)?.label || BACKEND_LABEL[id] || id,
    [report?.runtimes],
  );

  // The sweep is excluded from the panel's OWN disable: pressing Stop has to stay
  // available while the queue is what is busy.
  const localBusy = running || removing;
  const busy = localBusy || sweepRunning;
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
        far throughput falls off as context grows — across every local runtime PortOS can reach
        (Ollama, LM Studio, llama.cpp, MTPLX, vLLM). Throughput is reported in tokens per second wherever
        the runtime reports token counts. Measure a model under more than one launch tuning to
        see which configuration this machine actually prefers, or start a sweep to measure everything at
        once. Results stay on this machine — they describe this hardware, so they are never synced to a peer.
      </p>

      <RuntimeRoster runtimes={report?.runtimes} />

      <OpenCodeAgentBenchmarkPanel
        results={agentBenchmarkResults}
        running={agentBenchmarkRunning || busy}
        onRun={runAgentBenchmark}
      />

      {/* The batch run. Kept above the ranking because it is what you come here
          to press at the end of the day; the results below are what you read the
          next morning. Disabled while a single-model run holds the provider —
          two measurements at once would measure the contention. */}
      <AssessmentSweepPanel
        counts={report?.sweepScopes}
        contextTokens={report?.defaultContextTokens || []}
        disabled={localBusy}
        onRunningChange={setSweepRunning}
        onSweepFinished={() => load(intent)}
        tuningRequest={tuningSweepRequest}
        onTuningRequestClose={closeSweepTarget}
      />

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
              Could not list installed models for {report.listErrors.map((b) => backendLabel(report, b)).join(', ')} —
              models there may be missing from this list.
            </p>
          )}

          {report.ranked.length > 0 ? (
            <div className="space-y-2">
              {report.ranked.map((entry) => (
                <RankedRow
                  key={entryKey(entry)}
                  entry={entry}
                  runtimeLabel={backendLabel(report, entry.backend)}
                  busy={busy}
                  sweepVariants={gridFor(report, entry.backend).length}
                  onRemeasure={openTarget}
                  onDelete={removeAssessment}
                  onSweepTunings={openSweepTarget}
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
                <div key={entryKey(entry)} className="flex items-center gap-2 text-xs flex-wrap">
                  <span className="text-gray-300 font-mono break-all">{entry.modelId}</span>
                  {/* Several rows can name the same model — one per tuning — so
                      the configuration is what tells them apart. */}
                  <span className="px-1.5 py-0.5 text-[10px] rounded border border-port-border text-gray-500">
                    {entry.tuningLabel || 'backend defaults'}
                  </span>
                  <VerdictPill verdict={entry.verdict} />
                  {entry.reason && <span className="text-gray-500">{entry.reason}</span>}
                </div>
              ))}
            </div>
          )}

          <ModelThroughputReport
            report={report.throughputReport}
            runtimeLabelFor={runtimeLabelFor}
          />

          <TuningComparison
            rows={report.tuningComparison}
            runtimeLabelFor={runtimeLabelFor}
          />

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
                  <div key={modelKey(entry)} className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-gray-300 font-mono break-all min-w-0">
                      {entry.modelId}
                      <span className="text-gray-600 ml-2">{backendLabel(report, entry.backend)}</span>
                    </span>
                    <button
                      onClick={() => openTarget(entry)}
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

      <AssessmentDrawer
        target={pendingTarget}
        unknownTarget={Boolean(report) && !measureMatch && !running}
        runtimeLabel={backendLabel(report, pendingTarget?.backend)}
        contextTokens={report?.defaultContextTokens || []}
        tuningSpecs={specsFor(report, pendingTarget?.backend)}
        tuning={tuningDraft}
        onTuningChange={setTuningEdits}
        running={running}
        progress={progress}
        onClose={cancelRun}
        onConfirm={confirmRun}
      />
    </div>
  );
}

export default LocalModelAssessments;
