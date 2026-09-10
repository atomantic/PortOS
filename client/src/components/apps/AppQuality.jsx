import AppQualityHistory from './AppQualityHistory';
import { Link } from 'react-router';
import { formatDateShort } from '../../utils/formatters';

export default function AppQuality({ app, detail = false }) {
  const quality = app.quality;
  const score = quality?.score;
  const hasAssessments = quality?.categories?.some(category => category.assessedAt);
  const unscoredLabel = hasAssessments ? 'Quality: no qualifying score' : 'Quality: not assessed';
  const label = quality?.unavailable ? 'Quality unavailable'
    : score == null ? unscoredLabel : `Quality: ${score}/100`;
  if (!detail) return (
    <Link to={`/apps/${app.id}/overview`} className="text-xs text-port-accent hover:underline" title="View audit scores and coverage">
      {label}{score != null && ` · ${quality.ratedCategories}/${quality.totalCategories} categories`}
    </Link>
  );
  return (
    <section aria-label="App quality" className="bg-port-card border border-port-border rounded-lg p-4 space-y-3">
      <h3 className="font-semibold text-white">{label}</h3>
      <p className="text-xs text-gray-400">
        Assessments describe the code before fixes. The overall score is the equal-weight mean of broad, medium/high-confidence assessments from the last 30 days.
        {' '}{quality?.ratedCategories ?? 0}/{quality?.totalCategories ?? 0} categories contribute. Missing, partial, low-confidence and stale assessments are excluded, not counted as perfect.
      </p>
      {score == null && !quality?.unavailable && (
        <p className="text-sm text-gray-400">
          {hasAssessments
            ? 'Saved assessments do not currently qualify for an overall score. Check the category breakdown for coverage, confidence and age.'
            : 'No audit assessment has been saved. Completed maintenance tasks only supply a score when they return a valid quality report. Earlier runs are not scored retroactively; run a scheduled audit to collect an assessment.'}
        </p>
      )}
      <Link to={`/apps/${app.id}/tasks`} className="inline-block text-sm text-port-accent hover:underline">Configure or run scheduled audits</Link>
      <AppQualityHistory appId={app.id} categories={quality?.categories} />
      {!!quality?.categories?.length && (
        <details>
          <summary className="cursor-pointer text-sm text-port-accent">Category breakdown</summary>
          <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="text-gray-400"><tr><th className="py-2 pr-3">Category</th><th className="pr-3">Score</th><th>Evidence</th></tr></thead>
            <tbody>{quality.categories.map(category => (
              <tr key={category.id} className="border-t border-port-border align-top">
                <th scope="row" className="py-2 pr-3 font-medium">{category.label}</th>
                <td className="py-2 pr-3 whitespace-nowrap">{category.score == null ? '—' : `${category.score}/100`}</td>
                <td className="py-2 text-xs text-gray-400">
                  <div>{category.stale ? 'Stale · ' : ''}{category.coverage}{category.confidence && ` · ${category.confidence} confidence`}
                    {category.assessedAt && ` · ${formatDateShort(category.assessedAt)}`}</div>
                  {category.summary && <p className="mt-1 break-words">{category.summary}</p>}
                  {category.totalFiles > 0 && <div>{category.scannedFiles}/{category.totalFiles} files scanned · Worst severity: {category.worstSeverity}/10</div>}
                  {category.agentId && <Link className="text-port-accent hover:underline" to={`/cos/agents/${category.agentId}`}>Audit run</Link>}
                </td>
              </tr>
            ))}</tbody>
          </table>
          </div>
        </details>
      )}
    </section>
  );
}
