import ConfirmButtonPair from '../../../components/ui/ConfirmButtonPair';
import useConfirmDelete from '../../../hooks/useConfirmDelete';
import { Link } from 'react-router';
import { BarChart3, RefreshCw, SlidersHorizontal, Trash2 } from 'lucide-react';
import { TestCell } from '../ModelTestCell.jsx';
import CapabilityBadges from '../../models/CapabilityBadges.jsx';
import { reasoningHiddenTitle } from '../ModelThroughputReport';
import { formatContextTokens, formatDurationMs, throughputLabel } from '../../../utils/formatters';
import { localModelAssessmentPath } from '../../../lib/localModelAssessmentKey';
import { StalePill, VerdictPill } from './AssessmentBadges';

const AXIS_LABEL = { capability: 'Capability', speed: 'Speed', fidelity: 'Context stability', memory: 'Memory headroom' };


// `null` is NOT MEASURED and must render as such — never as 0, and never as a
// dash the reader could mistake for "measured, none".
const Measured = ({ value, suffix = '', digits = 0 }) =>
  (typeof value === 'number' && Number.isFinite(value)
    ? <>{value.toFixed(digits)}{suffix}</>
    : <span className="text-gray-600 italic">not measured</span>);

/**
 * What this model has PROVED, beside what it is fast at.
 *
 * Only tests that apply are shown. An unclaimed capability is left out entirely
 * rather than rendered as a grey "n/a" on every row — the matrix in the suite
 * panel above is where the full grid lives; here it would be columns of nothing
 * on the models that matter most.
 *
 * The chips themselves are the matrix's own `TestCell`, so the two surfaces on
 * one page cannot drift into rendering the same verdict differently.
 */
function CapabilityStrip({ capability, backend, modelId, tests, onOpen }) {
  if (!capability) return null;
  const runnable = (capability.tests || []).filter((t) => t.state === 'applicable' || t.state === 'unknown');
  if (!runnable.length) return null;
  const labelFor = (testId) => tests?.find((t) => t.id === testId)?.label || testId;

  return (
    <div className="border-t border-port-border/70 pt-2 flex items-center gap-2 flex-wrap">
      <span className="text-[11px] text-gray-500">Capability tests</span>
      {runnable.map((slot) => (
        <span key={slot.testId} className="flex items-center gap-1.5">
          <span className="text-[11px] text-gray-400">{labelFor(slot.testId)}</span>
          <TestCell slot={slot} onOpen={() => onOpen(backend, modelId, slot.testId)} />
        </span>
      ))}
    </div>
  );
}

export default function RankedAssessmentRow({ entry, runtimeLabel, onRemeasure, onDelete, onSweepTunings, sweepVariants, busy, capability, capabilityTests, onOpenCapabilityTest, selected, search }) {
  const { isConfirming, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();
  const perf = entry.performance || {};
  return (
    <div className={`bg-port-bg border rounded-lg p-3 space-y-2 ${selected ? 'border-port-accent/70' : 'border-port-border'}`}>
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
            {/* What the model CLAIMS, from the same badge component the install
                catalog renders — the claim is what decides which tests below
                apply, so the two must never disagree. */}
            {capability && <CapabilityBadges capabilities={capability.capabilities} />}
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
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <Link
            to={{ pathname: localModelAssessmentPath(entry), search }}
            aria-label={`View evidence for ${entry.modelId}`}
            aria-current={selected ? 'page' : undefined}
            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 text-gray-400 hover:text-port-accent transition-colors"
            title="View selected evidence"
          >
            <BarChart3 size={13} />
          </Link>
          <button
            onClick={() => onRemeasure(entry)}
            disabled={busy}
            title="Measure again (and adjust tuning)"
            aria-label={`Measure ${entry.modelId} again`}
            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 text-gray-400 hover:text-white transition-colors disabled:opacity-50"
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
              className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 text-gray-400 hover:text-white transition-colors disabled:opacity-50"
            >
              <SlidersHorizontal size={13} />
            </button>
          )}
          {isConfirming(entry) ? (
            <ConfirmButtonPair
              prompt="Discard measurement?"
              confirmText="Discard"
              onConfirm={() => confirmDelete(() => onDelete(entry))}
              onCancel={cancelDelete}
              busy={busy}
              className="flex-wrap"
            />
          ) : (
            <button
              onClick={() => requestDelete(entry)}
              disabled={busy}
              title="Discard this measurement"
              aria-label={`Discard the measurement for ${entry.modelId}`}
              className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 text-gray-400 hover:text-port-error transition-colors disabled:opacity-50"
            >
              <Trash2 size={13} />
            </button>
          )}
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
            {throughputLabel(perf) || (perf.reasoningHidden === true
              ? <span className="text-gray-600 italic" title={reasoningHiddenTitle(perf.meanTokensPerSecond)}>n/a (reasoning)</span>
              : <span className="text-gray-600 italic">not measured</span>)}
            {Number.isFinite(perf.meanTokensPerSecond) && (
              <span className="text-gray-600 ml-1.5 text-[10px]" title={perf.reasoningHidden === true ? reasoningHiddenTitle(perf.meanTokensPerSecond) : undefined}>
                {perf.reasoningHidden === true
                  ? 'chars/s n/a (reasoning)'
                  : <Measured value={perf.meanCharsPerSecond} suffix=" chars/s" />}
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

      <CapabilityStrip
        capability={capability}
        backend={entry.backend}
        modelId={entry.modelId}
        tests={capabilityTests}
        onOpen={onOpenCapabilityTest}
      />
    </div>
  );
}
