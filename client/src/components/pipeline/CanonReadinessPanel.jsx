import { useCallback, useState } from 'react';
import { Link } from 'react-router';
import { CheckCircle2, Loader2, ScanSearch, ShieldCheck } from 'lucide-react';
import toast from '../ui/Toast';
import { getPipelineSeriesCanonReadiness } from '../../services/api';

export default function CanonReadinessPanel({ seriesId }) {
  const [canon, setCanon] = useState(null);
  const [canonLoading, setCanonLoading] = useState(false);

  const checkCanon = useCallback(async () => {
    setCanonLoading(true);
    const report = await getPipelineSeriesCanonReadiness(seriesId, { silent: true })
      .catch((err) => { toast.error(err.message || 'Canon check failed'); return null; });
    setCanonLoading(false);
    if (report) setCanon(report);
  }, [seriesId]);

  return (
    <div className="px-3 pb-3 border-t border-port-border pt-2">
      <div className="flex items-center gap-2">
        <ShieldCheck size={13} className="text-gray-400" />
        <span className="text-xs text-gray-300">Production readiness — are all drawn characters/places/objects described?</span>
        <button
          type="button"
          onClick={checkCanon}
          disabled={canonLoading}
          className="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-gray-300 hover:text-white border border-port-border bg-port-bg hover:border-port-accent/40 disabled:opacity-40"
        >
          {canonLoading ? <Loader2 size={12} className="animate-spin" /> : <ScanSearch size={12} />}
          Check
        </button>
      </div>
      {canon ? (
        canon.ready ? (
          <p className="mt-2 text-xs text-port-success flex items-center gap-1.5">
            <CheckCircle2 size={12} /> Every noun that gets drawn has a description.
          </p>
        ) : (
          <div className="mt-2 space-y-2">
            {(canon.blockingIssues || []).some((bi) => bi.blockingReason === 'missing-visual-source') ? (
              <p className="text-xs text-port-warning">
                Some issues have no finished visual script yet. An outline or prose draft cannot prove canon is ready for rendering.
              </p>
            ) : null}
            {(canon.undescribed || []).length > 0 ? (
              <p className="text-xs text-port-warning">
                {canon.undescribed.length} noun(s) appear where they&apos;d be drawn but have no description — fix before generating art:
              </p>
            ) : null}
            {(canon.blockingIssues || []).map((bi) => (
              <div key={bi.issueId} className="space-y-1">
                {(bi.missingSourceStages || []).length > 0 ? (
                  <div className="text-xs">
                    <Link
                      to={`/pipeline/issues/${bi.issueId}/${bi.missingSourceStages[0]}`}
                      className="text-port-accent hover:underline"
                    >
                      #{bi.number} {bi.title || ''} — visual script →
                    </Link>
                    <span className="text-gray-400">
                      {' '}missing {bi.missingSourceStages.join(' + ')}
                    </span>
                  </div>
                ) : null}
                {(bi.none || []).length > 0 ? (
                  <div className="text-xs">
                    <Link
                      to={`/pipeline/issues/${bi.issueId}/nouns`}
                      className="text-port-accent hover:underline"
                    >
                      #{bi.number} {bi.title || ''} — canon nouns →
                    </Link>
                    <span className="text-gray-400">
                      {' '}{bi.none.map((n) => `${n.name} (${n.kind})`).join(', ')}
                    </span>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}
