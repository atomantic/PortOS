/**
 * Pipeline — Voice-Fingerprint Matrix (#2194, CWQE Phase 2 follow-up).
 *
 * A dedicated, deep-linkable surface for the deterministic voice-drift engine:
 * a monospace issues×metrics matrix where every drafted issue's full fingerprint
 * vector (sentence rhythm, fragment/long-sentence rates, paragraph shape,
 * dialogue ratio, em-dash rate, abstract-noun/simile density, dominant opener,
 * plus any configured vocabulary wells) is a row, and each statistical outlier
 * cell (> the series drift threshold in σ) is highlighted. The finding cards on
 * the Editorial Checks page only surface the FLAGGED outliers as prose; this view
 * shows the whole matrix + the series mean/σ footer so the drift is legible at a
 * glance. Read-only — no LLM cost.
 *
 * The series id is the route param (`/pipeline/series/:seriesId/voice-fingerprint`),
 * so the view is shareable/bookmarkable per the "URL is the source of truth"
 * convention. A stale/deleted id falls back to the pipeline index.
 */

import { useEffect, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { Loader2, ArrowLeft, Fingerprint, BookOpen, Info } from 'lucide-react';
import toast from '../components/ui/Toast';
import { getPipelineSeries, getVoiceFingerprint } from '../services/api';

// A cell is an outlier when the (issue, metricKey) pair is in the drift set.
// Keyed on `issue:metricKey` so a lookup is O(1) while rendering the grid.
const outlierKey = (issue, metricKey) => `${issue}:${metricKey}`;

export default function PipelineVoiceFingerprint() {
  const { seriesId } = useParams();
  const navigate = useNavigate();
  const [series, setSeries] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let canceled = false;
    setLoading(true);
    Promise.all([
      getPipelineSeries(seriesId, { silent: true }),
      getVoiceFingerprint(seriesId, { silent: true }),
    ])
      .then(([s, fp]) => {
        if (canceled) return;
        setSeries(s);
        setData(fp);
      })
      .catch((err) => {
        if (canceled) return;
        toast.error(err.message || 'Failed to load voice fingerprint');
        navigate('/pipeline');
      })
      .finally(() => { if (!canceled) setLoading(false); });
    return () => { canceled = true; };
  }, [seriesId, navigate]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-gray-400">
        <Loader2 className="animate-spin" size={20} />
      </div>
    );
  }

  const columns = data?.columns || [];
  const issues = data?.matrix?.issues || [];
  const seriesStats = data?.series || {};
  const outlierSet = new Set((data?.outliers || []).map((o) => outlierKey(o.issue, o.metricKey)));
  const hasMatrix = issues.length > 0;

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6">
      <header className="flex flex-wrap items-center gap-2 mb-4">
        <Link
          to={`/pipeline/series/${seriesId}`}
          className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-gray-400 hover:text-white border border-port-border bg-port-card"
          title="Back to series"
        >
          <ArrowLeft size={12} /> Series
        </Link>
        <h1 className="text-lg font-semibold text-white flex items-center gap-2">
          <Fingerprint size={18} className="text-port-accent" /> Voice Fingerprint
        </h1>
        {series?.name ? <span className="text-sm text-gray-400 truncate">— {series.name}</span> : null}
        <Link
          to="/pipeline/editorial-checks"
          className="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-gray-400 hover:text-white border border-port-border bg-port-card"
          title="Configure the style.voice-drift check (threshold, min issues, vocabulary wells)"
        >
          Editorial Checks
        </Link>
      </header>

      <p className="text-xs text-gray-500 mb-4 max-w-3xl">
        Every drafted issue's prose fingerprint. Each column is a metric; a cell
        highlighted in <span className="text-port-warning">amber</span> is a
        statistical outlier — more than {data?.threshold ?? 1.5}σ from the series
        mean on that metric. The bottom rows are the series mean and standard
        deviation (σ). This measures the same vectors the deterministic{' '}
        <code className="text-gray-400">style.voice-drift</code> editorial check
        flags; it just shows the whole matrix, not only the flagged outliers.
      </p>

      {!hasMatrix ? (
        <EmptyState gatedOff={data?.gatedOff} issueCount={data?.issueCount ?? 0} minIssues={data?.config?.minIssues} />
      ) : (
        <>
          {data?.gatedOff ? (
            <div className="mb-4 flex items-start gap-2 px-3 py-2 rounded-lg border border-port-border bg-port-card text-gray-400 text-sm">
              <Info size={14} className="mt-0.5 shrink-0" />
              <span>
                Drift detection is off — only {data.issueCount} issue
                {data.issueCount === 1 ? '' : 's'} drafted (minimum{' '}
                {data?.config?.minIssues ?? 4}). The fingerprint matrix is shown for
                reference, but no outliers are flagged until more issues exist.
              </span>
            </div>
          ) : null}
          <FingerprintMatrix
            columns={columns}
            issues={issues}
            seriesStats={seriesStats}
            outlierSet={outlierSet}
          />
          <p className="text-xs text-gray-500 mt-3">
            {issues.length} issue{issues.length === 1 ? '' : 's'} · {columns.length} metrics
            {data?.wells?.length ? ` · vocabulary wells: ${data.wells.join(', ')}` : ''}
            {data?.outliers?.length
              ? ` · ${data.outliers.length} outlier${data.outliers.length === 1 ? '' : 's'} flagged`
              : ''}
          </p>
        </>
      )}
    </div>
  );
}

function EmptyState({ gatedOff, issueCount, minIssues }) {
  if (gatedOff && issueCount > 0) {
    return (
      <div className="text-center text-gray-400 py-16">
        <Fingerprint className="mx-auto mb-3 opacity-40" size={28} />
        Only {issueCount} issue{issueCount === 1 ? '' : 's'} drafted — drift needs at
        least {minIssues ?? 4} to compute a stable series voice. Draft more issues,
        then return to see the fingerprint matrix.
      </div>
    );
  }
  return (
    <div className="text-center text-gray-400 py-16">
      <BookOpen className="mx-auto mb-3 opacity-40" size={28} />
      Nothing is drafted yet. Write or import a manuscript, then return to see each
      issue's voice fingerprint.
    </div>
  );
}

function FingerprintMatrix({ columns, issues, seriesStats, outlierSet }) {
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  return (
    <div className="overflow-x-auto border border-port-border rounded-lg">
      <table className="border-collapse font-mono text-xs w-full">
        <thead>
          <tr className="bg-port-card">
            <th className="sticky left-0 z-10 bg-port-card text-left text-gray-400 font-medium px-3 py-2 min-w-[4rem]">
              Issue
            </th>
            {columns.map((col) => (
              <th
                key={col.key}
                className="px-2 py-2 text-right text-gray-400 font-medium whitespace-nowrap align-bottom"
                title={`${col.label} — high = ${col.higher}; low = ${col.lower}`}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {issues.map((it) => (
            <tr key={it.issue} className="border-t border-port-border">
              <td className="sticky left-0 z-10 bg-port-bg text-gray-300 font-medium px-3 py-1.5">
                #{it.issue}
              </td>
              {columns.map((col) => {
                const v = it.metrics?.[col.key] ?? 0;
                const isOutlier = outlierSet.has(outlierKey(it.issue, col.key));
                return (
                  <td
                    key={col.key}
                    className={`px-2 py-1.5 text-right tabular-nums ${
                      isOutlier
                        ? 'bg-port-warning/20 text-port-warning font-semibold'
                        : 'text-gray-300'
                    }`}
                    title={isOutlier ? `Outlier — series mean ${round2(seriesStats?.[col.key]?.mean)}${col.unit || ''}` : undefined}
                  >
                    {round2(v)}{col.unit || ''}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-port-border bg-port-card">
            <td className="sticky left-0 z-10 bg-port-card text-gray-500 px-3 py-1.5">mean</td>
            {columns.map((col) => (
              <td key={col.key} className="px-2 py-1.5 text-right text-gray-500 tabular-nums">
                {round2(seriesStats?.[col.key]?.mean)}{col.unit || ''}
              </td>
            ))}
          </tr>
          <tr className="bg-port-card">
            <td className="sticky left-0 z-10 bg-port-card text-gray-500 px-3 py-1.5">σ</td>
            {columns.map((col) => (
              <td key={col.key} className="px-2 py-1.5 text-right text-gray-500 tabular-nums">
                {round2(seriesStats?.[col.key]?.std)}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
