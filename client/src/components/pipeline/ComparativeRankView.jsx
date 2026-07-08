/**
 * Comparative Rank view (#2169, CWQE Phase 5) — the "Rankings" tab on the Reader
 * Map page. Runs a head-to-head Swiss/Elo tournament across the series' drafted
 * issues (forced-pick pairwise comparison — "you are not allowed to call it a
 * tie") and renders the resulting order beside the per-issue health/quality
 * scores. Absolute rubric scores collapse into a narrow band; the ranking forces
 * the discrimination the autopilot's weakest-issue selector (Phase 7) needs.
 *
 * Running the tournament spends one LLM call per match and fires ONLY from the
 * explicit button here (AI-provider policy).
 */

import { useEffect, useState, useCallback } from 'react';
import { Loader2, Trophy, Swords, AlertTriangle } from 'lucide-react';
import { getComparativeRank, runComparativeRank } from '../../services/apiPipeline';
import { useAsyncAction } from '../../hooks/useAsyncAction';

const fmtRating = (r) => (Number.isFinite(r) ? Math.round(r) : '—');

export default function ComparativeRankView({ seriesId, hasContent }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    // The view owns its empty/error UI, so silence the shared toast.
    const res = await getComparativeRank(seriesId, { silent: true }).catch(() => null);
    setData(res);
    setLoading(false);
  }, [seriesId]);

  useEffect(() => { load(); }, [load]);

  const [run, running] = useAsyncAction(async () => {
    const res = await runComparativeRank(seriesId, {}, { silent: true });
    setData(res);
    return res;
  }, { errorMessage: 'Failed to rank issues' });

  const status = data?.status;
  const ranking = Array.isArray(data?.ranking) ? data.ranking : [];
  const weakestIds = new Set((data?.weakest || []).map((w) => w.issueId));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-xs uppercase tracking-wider text-gray-500 flex items-center gap-1.5">
            <Swords size={13} className="text-port-accent" /> Head-to-head ranking
          </h2>
          <p className="mt-0.5 text-[11px] text-gray-600">
            Forced-pick pairwise comparison + Elo — sharper than the per-issue score band.
            {status === 'complete' ? ` ${data.entrants} issues · ${data.rounds} rounds · ${data.matches?.length ?? 0} matches` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {data?.stale ? (
            <span className="inline-flex items-center gap-1 text-[11px] text-port-warning" title="Drafts changed since this ranking was computed">
              <AlertTriangle size={12} /> stale
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => run()}
            disabled={running || !hasContent}
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-port-accent/15 border border-port-accent/40 text-port-accent hover:bg-port-accent/25 disabled:opacity-40 disabled:cursor-not-allowed"
            title={!hasContent ? 'No drafted content to rank yet' : 'Compare every drafted issue head-to-head'}
          >
            {running ? <Loader2 size={13} className="animate-spin" /> : <Trophy size={13} />}
            {status === 'complete' ? 'Re-rank' : 'Rank issues'}
          </button>
        </div>
      </div>

      {loading ? (
        <p className="text-xs text-gray-500 italic">Loading…</p>
      ) : status === 'insufficient' ? (
        <p className="text-xs text-gray-500 italic">
          Need at least two drafted issues to run a head-to-head ranking.
        </p>
      ) : status === 'complete' && ranking.length ? (
        <div className="overflow-x-auto rounded-lg border border-port-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wider text-gray-500 bg-port-bg/60">
                <th className="text-left font-medium px-3 py-2">#</th>
                <th className="text-left font-medium px-3 py-2">Issue</th>
                <th className="text-right font-medium px-3 py-2">Elo</th>
                <th className="text-right font-medium px-3 py-2">W–L</th>
              </tr>
            </thead>
            <tbody>
              {ranking.map((row) => (
                <tr
                  key={row.issueId}
                  className={`border-t border-port-border ${weakestIds.has(row.issueId) ? 'bg-rose-500/5' : ''}`}
                >
                  <td className="px-3 py-2 font-mono text-gray-400">{row.rank}</td>
                  <td className="px-3 py-2 min-w-0">
                    <span className="font-mono text-[11px] text-gray-500 mr-1.5">{row.label}</span>
                    <span className="text-gray-200">{row.title || 'Untitled'}</span>
                    {weakestIds.has(row.issueId) ? (
                      <span className="ml-2 text-[9px] uppercase tracking-wide text-rose-300/80">revision priority</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-gray-300">{fmtRating(row.rating)}</td>
                  <td className="px-3 py-2 text-right font-mono text-gray-500">{row.wins}–{row.losses}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-xs text-gray-500 italic">
          {hasContent
            ? 'Not ranked yet. Run the head-to-head tournament to order issues by comparative quality.'
            : 'No drafted content yet. Write or generate prose/scripts, then run the ranking.'}
        </p>
      )}
    </div>
  );
}
