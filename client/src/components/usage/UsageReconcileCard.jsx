import { DatabaseZap } from 'lucide-react';
import BrailleSpinner from '../BrailleSpinner';
import { formatCount } from '../../utils/formatters';

function joinAnd(parts) {
  if (parts.length <= 1) return parts[0] || '';
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}`;
}

/** What Reconcile now added to the Grok ledger. Absent until that job finishes. */
function grokRepairLine(grok) {
  if (!grok) return '';
  const parts = [];
  if (grok.turns) parts.push(`${formatCount(grok.turns)} long-context turn${grok.turns === 1 ? '' : 's'}`);
  if (grok.fast) parts.push(`${formatCount(grok.fast)} fast turn${grok.fast === 1 ? '' : 's'}`);
  if (grok.images) parts.push(`${formatCount(grok.images)} image${grok.images === 1 ? '' : 's'}`);
  if (grok.videos) parts.push(`${formatCount(grok.videos)} video${grok.videos === 1 ? '' : 's'}`);
  const added = parts.length ? `Added ${joinAnd(parts)}.` : 'Grok usage was already recorded.';
  return grok.note ? `${added} ${grok.note}` : added;
}

/** What Reconcile now added for Codex speed. Absent until that job finishes. */
function codexRepairLine(codex) {
  if (!codex) return '';
  const added = codex.sessions
    ? `Added fast-mode premiums for ${formatCount(codex.sessions)} Codex session${codex.sessions === 1 ? '' : 's'}.`
    : 'Codex speed premiums were already recorded.';
  return codex.note ? `${added} ${codex.note}` : added;
}

/** What Reconcile now added to the Antigravity ledger. Absent until that job finishes. */
function agyRepairLine(agy) {
  if (!agy) return '';
  const parts = [];
  if (agy.images) parts.push(`${formatCount(agy.images)} image${agy.images === 1 ? '' : 's'}`);
  const added = parts.length ? `Added ${joinAnd(parts)}.` : 'Antigravity usage was already recorded.';
  return agy.note ? `${added} ${agy.note}` : added;
}

export default function UsageReconcileCard({ backfill, startBackfill, reconciling }) {
  const finished = backfill?.status === 'complete' || backfill?.status === 'error';
  return (
    <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
      <div>
        <div className="flex items-center gap-2 text-sm font-medium text-white">
          <DatabaseZap size={16} className="text-port-accent" />
          Reconcile historical usage
        </div>
        <p className="text-xs text-gray-500 mt-1">
          Re-read saved transcripts, Grok sessions, and Antigravity media to replace older estimates and record media, long-context, and speed premiums. This changes this machine’s recorded history but makes no provider calls. It cannot repair peer classifications or restore deleted transcripts; use the chart’s coverage details for those gaps.
        </p>
        {backfill?.status === 'running' && (
          <p className="text-xs text-port-accent mt-1" role="status">
            Processing {backfill.processed || 0} of {backfill.total || 0} runs…
          </p>
        )}
        {backfill?.status === 'complete' && (
          <p className="text-xs text-port-success mt-1" role="status">
            Corrected {backfill.corrected || 0} run{backfill.corrected === 1 ? '' : 's'}.
          </p>
        )}
        {backfill?.grok && finished && (
          <p className="text-xs text-port-success mt-1" role="status">{grokRepairLine(backfill.grok)}</p>
        )}
        {backfill?.codex && finished && (
          <p className="text-xs text-port-success mt-1" role="status">{codexRepairLine(backfill.codex)}</p>
        )}
        {backfill?.agy && finished && (
          <p className="text-xs text-port-success mt-1" role="status">{agyRepairLine(backfill.agy)}</p>
        )}
        {backfill?.status === 'error' && (
          <p className="text-xs text-port-error mt-1" role="alert">{backfill.error}</p>
        )}
      </div>
      <button
        type="button"
        onClick={startBackfill}
        disabled={reconciling}
        className="shrink-0 inline-flex items-center justify-center gap-2 rounded-lg border border-port-border px-3 py-2 text-sm text-white hover:border-port-accent disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {reconciling ? <BrailleSpinner /> : <DatabaseZap size={15} />}
        {backfill?.status === 'running' ? 'Reconciling…' : 'Reconcile now'}
      </button>
    </div>
  );
}
