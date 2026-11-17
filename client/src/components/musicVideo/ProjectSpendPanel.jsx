import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { SPEND_ADJUSTMENT_LANES, projectSpend, spendLaneLabel } from '../../lib/musicVideoStages.js';
import { addMusicVideoSpendAdjustment, deleteMusicVideoSpendAdjustment } from '../../services/apiMusicVideo.js';
import useAsyncAction from '../../hooks/useAsyncAction.js';
import { formatCount, formatDateTime, formatUsd } from '../../utils/formatters.js';

const inputClass = 'w-full min-w-0 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm min-h-[44px] pointer-fine:sm:min-h-0';
const buttonClass = 'inline-flex items-center justify-center gap-1 rounded border border-port-border px-3 py-1.5 text-sm hover:bg-port-card focus-visible:ring-2 focus-visible:ring-port-accent disabled:opacity-50 min-h-[44px] pointer-fine:sm:min-h-0';
const renders = (n) => `${formatCount(n, { fallback: '0' })} render${n === 1 ? '' : 's'}`;

/**
 * Project settings › Spend (#16506): what this video's renders cost, by paid lane, with each lane's
 * unpriced renders counted rather than read as $0, and a true-up that states a lane's real spend
 * from the provider's balance. The ledger is this machine's: renders another machine ran stay in
 * that machine's spend.
 */
export default function ProjectSpendPanel({ project, onProjectUpdated }) {
  const spend = projectSpend(project);
  const [lane, setLane] = useState(SPEND_ADJUSTMENT_LANES[0]);
  const [actual, setActual] = useState('');
  const [note, setNote] = useState('');
  const apply = (renderSpend) => { if (renderSpend) onProjectUpdated?.({ ...project, renderSpend }); };
  const [save, saving] = useAsyncAction(async () => {
    const res = await addMusicVideoSpendAdjustment(project.id, { lane, actualUsd: Number(actual), ...(note.trim() ? { note: note.trim() } : {}) }, { silent: true });
    apply(res.renderSpend);
    setActual('');
    setNote('');
  }, { errorMessage: 'Could not save the spend adjustment' });
  const [remove, removing] = useAsyncAction(async (id) => {
    apply((await deleteMusicVideoSpendAdjustment(project.id, id, { silent: true })).renderSpend);
  }, { errorMessage: 'Could not remove the spend adjustment' });
  const actualValid = actual.trim() !== '' && Number.isFinite(Number(actual)) && Number(actual) >= 0;
  const adjustments = project.renderSpend?.adjustments || [];
  const currentLane = spend.lanes.find((row) => row.lane === lane);

  return (
    <section aria-labelledby="mv-spend-heading" className="min-w-0 space-y-3">
      <div className="space-y-1">
        <h3 id="mv-spend-heading" className="text-sm font-medium">
          Spend {formatUsd(spend.spentUsd)}{spend.capUsd != null ? ` of ${formatUsd(spend.capUsd)} cap` : ''}
        </h3>
        <p className="text-xs text-port-text-muted">
          Estimated from each paid render&apos;s list price on this machine, kept or not. Your provider&apos;s balance is the final word: true a lane up below.
        </p>
        {spend.unpriced > 0 && (
          <p role="status" className="text-xs text-port-warning">{renders(spend.unpriced)} with no listed price {spend.unpriced === 1 ? 'is' : 'are'} not in the total.</p>
        )}
      </div>

      {spend.lanes.length ? (
        <ul className="divide-y divide-port-border rounded border border-port-border text-sm">
          {spend.lanes.map((row) => (
            <li key={row.lane} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-3 py-2">
              <span className="min-w-0 font-medium">{row.label}</span>
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 text-xs text-port-text-muted">
                {row.lane !== 'earlier' && <span>{renders(row.count)}</span>}
                {row.unpriced > 0 && <span className="text-port-warning">unpriced renders: {formatCount(row.unpriced)}</span>}
                {row.adjustmentUsd !== 0 && <span>adjusted {formatUsd(row.adjustmentUsd, { signed: true })}</span>}
                <span className="text-sm text-port-text">{formatUsd(row.totalUsd)}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-port-text-muted">No paid renders recorded for this video on this machine yet.</p>
      )}
      <p className="text-xs text-port-text-muted">
        Autopilot {formatUsd(spend.autopilot)} · shot takes and tests {formatUsd(spend.manual)} · auto-review {formatUsd(spend.autoReview)}
        {spend.adjustmentsUsd !== 0 ? ` · adjustments ${formatUsd(spend.adjustmentsUsd, { signed: true })}` : ''}
      </p>

      <form
        className="grid min-w-0 grid-cols-1 gap-2 rounded border border-port-border p-3 sm:grid-cols-[minmax(0,10rem)_minmax(0,8rem)_minmax(0,1fr)_auto] sm:items-end"
        onSubmit={(e) => { e.preventDefault(); if (actualValid && !saving) save(); }}
      >
        <div className="min-w-0">
          <label htmlFor="mv-spend-lane" className="mb-1 block text-xs text-port-text-muted">Actual spend on</label>
          <select id="mv-spend-lane" value={lane} onChange={(e) => setLane(e.target.value)} className={inputClass}>
            {SPEND_ADJUSTMENT_LANES.map((id) => <option key={id} value={id}>{spendLaneLabel(id)}</option>)}
          </select>
        </div>
        <div className="min-w-0">
          <label htmlFor="mv-spend-actual" className="mb-1 block text-xs text-port-text-muted">is (USD)</label>
          <input
            id="mv-spend-actual" type="number" min="0" step="0.01" inputMode="decimal" value={actual}
            onChange={(e) => setActual(e.target.value)} placeholder={formatUsd(currentLane?.totalUsd ?? 0)} className={inputClass}
          />
        </div>
        <div className="min-w-0">
          <label htmlFor="mv-spend-note" className="mb-1 block text-xs text-port-text-muted">Note</label>
          <input id="mv-spend-note" type="text" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="From the provider's billing page" className={inputClass} />
        </div>
        <button type="submit" disabled={!actualValid || saving} className={buttonClass}>{saving ? 'Saving…' : 'Save'}</button>
      </form>

      {adjustments.length > 0 && (
        <ul aria-label="Spend adjustments" className="space-y-1 text-xs">
          {adjustments.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-port-border px-3 py-1.5">
              <span className="min-w-0 break-words">
                {spendLaneLabel(a.lane)} {formatUsd(a.usd, { signed: true })}
                {a.statedUsd != null ? ` (stated ${formatUsd(a.statedUsd)})` : ''}
                {a.note ? ` · ${a.note}` : ''} · {formatDateTime(a.at)}
              </span>
              <button
                type="button" onClick={() => remove(a.id)} disabled={removing}
                aria-label={`Remove the ${spendLaneLabel(a.lane)} adjustment`}
                className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded border border-port-border hover:bg-port-card disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
