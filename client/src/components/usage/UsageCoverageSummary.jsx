import { formatCount } from '../../utils/formatters';
import { NativeSourcesNote } from './CostReportSection';

export default function UsageCoverageSummary({ coverage, nativeSources }) {
  if (!coverage) return null;
  return (
    <div className="text-xs text-gray-400 space-y-1" role="status">
      <p>Usage from {formatCount(coverage.instanceCount)} reported instance{coverage.instanceCount === 1 ? '' : 's'}; peer data reflects the last sync.</p>
      {coverage.instanceCount > 1 && <p>Each instance snapshot is counted once. Runs recorded independently on multiple machines cannot be deduplicated from the available aggregates.</p>}
      <NativeSourcesNote sources={nativeSources} />
      <p>Cost classifications use each instance&rsquo;s current provider configuration; historical configuration changes are not available.</p>
      {coverage.pricingIncomplete && <p className="text-port-warning">Some provider classifications are unavailable. Fleet API cost includes only classified usage and is incomplete.</p>}
      {coverage.classificationUnreported?.length > 0 && <p className="text-port-warning">Provider classifications have not been reported by {coverage.classificationUnreported.join(', ')}.</p>}
      {coverage.missingInstances?.length > 0 && <p className="text-port-warning">No usage snapshot from {coverage.missingInstances.join(', ')}. Totals are incomplete.</p>}
      {coverage.notSyncingInstances?.length > 0 && <p>Usage sync is off for {coverage.notSyncingInstances.join(', ')}. Their saved history remains included.</p>}
      {coverage.transcriptUnreported?.length > 0 && <p className="text-port-warning">Claude transcript history has not been reported by {coverage.transcriptUnreported.join(', ')}; the monthly chart may be incomplete.</p>}
      {coverage.incompleteMonths?.length > 0 && <p className="text-port-warning">Older usage is available only by month. Partial months {coverage.incompleteMonths.join(', ')} are excluded; totals are incomplete.</p>}
    </div>
  );
}
