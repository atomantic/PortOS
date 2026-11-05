import { Link } from 'react-router';
import { formatCount, timeAgo } from '../../utils/formatters';

const actionClass = 'inline-flex min-h-11 items-center rounded-lg border border-port-border px-3 text-port-text hover:border-port-accent';
const reasons = {
  'classification-not-reported': 'This snapshot did not include provider classifications. An older peer version or a snapshot captured before that feature was available can cause this.',
  'provider-not-configured': 'This provider is absent from the reporting instance’s current classification map. It may have been removed or renamed; its past billing configuration is not recorded.',
  'legacy-unattributed': 'These older counts have no provider attribution. Their paid/free status and overlap with Claude transcripts cannot be recovered from the aggregate alone.',
};

function observedRange(gap) {
  if (!gap.from || !gap.to) return 'Dates unavailable (undated history)';
  const span = gap.from === gap.to ? gap.from : `${gap.from} to ${gap.to}`;
  const resolution = gap.resolution === 'month' ? 'monthly buckets' : gap.resolution === 'mixed' ? 'mixed-resolution history' : 'daily buckets';
  return `Observed ${span} UTC (${resolution})${gap.hasUndatedUsage ? '; also includes undated history' : ''}`;
}

/** Diagnostics describe this chart's contributing range, never another chart's filter. */
export default function UsageCoverageNotice({ coverage, pricingIncomplete = false, onReconcile, reconciling = false }) {
  const gaps = coverage?.classificationGaps || [];
  const missing = coverage?.missingInstances || [];
  const transcripts = coverage?.transcriptUnreported || [];
  const months = coverage?.incompleteMonths || [];
  const unpriced = coverage?.pricingIncomplete || pricingIncomplete;
  if (!unpriced && !missing.length && !transcripts.length && !months.length) return null;

  const gapInstances = [...new Set(gaps.map((gap) => gap.instanceName))];
  const names = gapInstances.length ? gapInstances : coverage?.classificationUnreported || [];
  const peerGap = gaps.some((gap) => !gap.self) || (coverage?.classificationUnreported?.length > 0) || missing.length > 0 || transcripts.length > 0;
  return (
    <div className="rounded-lg border border-port-warning/30 bg-port-warning/5 p-3 text-xs space-y-2" role="note" aria-label="Chart coverage gaps">
      <p className="font-medium text-port-warning">
        Partial chart:{unpriced && ` unpriced ledger usage${names.length ? ` from ${names.join(', ')}` : ''}.`}
        {missing.length > 0 && ` No usage snapshot from ${missing.join(', ')}.`}
        {transcripts.length > 0 && ` Claude transcript history not reported by ${transcripts.join(', ')}.`}
        {months.length > 0 && ` Partial monthly rollups excluded: ${months.join(', ')}.`}
      </p>
      <details>
        <summary className="min-h-11 py-3 cursor-pointer text-port-text">What’s missing and how to fix it</summary>
        <div className="space-y-3 text-gray-400">
          {coverage?.range && <p>Accounting window: {coverage.range.from || 'beginning of recorded history'} to {coverage.range.to || 'latest recorded history'} (UTC). Observed dates below identify affected buckets, not a continuous period of missing activity.</p>}
          {unpriced && <p>These ledger tokens are recorded, but their API cost is excluded until their billing classification is known. They may overlap Claude transcript totals; unknown overlap is not treated as zero or automatically added as extra spend.</p>}
          {gaps.length > 0 ? <ul className="space-y-3 max-h-72 overflow-y-auto" aria-label="Unclassified usage by instance and provider">
            {gaps.map((gap) => <li key={`${gap.instanceId}:${gap.providerId}`} className="border-l-2 border-port-warning/40 pl-3 space-y-1 break-words">
              <p className="font-medium text-port-text">{gap.instanceName}{gap.self ? ' (this machine)' : ''} · {gap.providerName || gap.providerId}</p>
              <p>Provider ID: {gap.providerId}. {formatCount(gap.tokens)} recorded tokens · {formatCount(gap.sessions)} sessions. Cost unknown.</p>
              <p>{observedRange(gap)}.</p>
              <p>{gap.models?.length ? `Models: ${gap.models.join(', ')}.` : 'Model attribution unavailable.'}</p>
              <p>{reasons[gap.reason] || 'Billing classification unavailable; the source did not provide enough evidence to classify it safely.'}</p>
              {!gap.self && <p title={gap.capturedAt || undefined}>Snapshot: {gap.capturedAt ? timeAgo(gap.capturedAt, 'time unavailable') : 'capture time unavailable'}.</p>}
            </li>)}
          </ul> : unpriced && <p>This server did not provide per-provider diagnostics. Update this instance to identify the affected provider and dates.</p>}
          {missing.length > 0 && <p>No snapshot means the missing providers, dates, tokens and cost are unknown. Check that the named instance is online and usage sync is enabled.</p>}
          {transcripts.length > 0 && <p>A missing Claude transcript summary does not prove there were no sessions. Update the named instance and let it scan its saved Claude transcripts, then sync usage.</p>}
          {months.length > 0 && <p>Older records exist only as whole-month totals. Select full calendar months to include them; daily detail cannot be invented.</p>}
          {peerGap && <>
            <p>Update the affected peer, then use Sync now in Instances to receive its current usage and provider classifications. A successful sync cannot restore deleted provider settings or lost transcripts. Local reconciliation does not repair another machine’s history.</p>
            <Link className={actionClass} to="/instances">Open instance sync</Link>
          </>}
          {gaps.some((gap) => gap.self && gap.reason === 'provider-not-configured') && <>
            <p>Check this machine’s provider configuration against the listed provider ID. Do not guess a paid/free classification from a model name.</p>
            <Link className={actionClass} to="/ai/presets">Review local providers</Link>
          </>}
          {onReconcile && <div className="space-y-2 border-t border-port-border pt-3">
            <p>Local history repair re-reads saved run transcripts and media receipts without AI/provider calls. It changes recorded history, but cannot restore missing peer classifications, deleted transcripts or dates absent from old aggregates.</p>
            <button type="button" className={`${actionClass} disabled:opacity-50 disabled:cursor-not-allowed`} onClick={onReconcile} disabled={reconciling}>{reconciling ? 'Reconciling local history…' : 'Reconcile local history'}</button>
          </div>}
        </div>
      </details>
    </div>
  );
}
