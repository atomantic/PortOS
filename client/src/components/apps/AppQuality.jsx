import AppQualityRunner from './AppQualityRunner';
import AppQualityHistory from './AppQualityHistory';
import { Fragment } from 'react';
import { Link, useSearchParams } from 'react-router';
import { formatDateShort } from '../../utils/formatters';

export default function AppQuality({ app, detail = false }) {
  const [params] = useSearchParams();
  const quality = app.quality;
  const selectedCategory = quality?.categories?.find(category => category.id === params.get('qualityCheck'));
  const runnerLink = categoryId => {
    const next = new URLSearchParams(params);
    next.set('qualityCheck', categoryId);
    return { search: next.toString(), hash: '#quality-runner' };
  };
  const score = quality?.score;
  const hasAssessments = quality?.categories?.some(category => category.assessedAt);
  const unscoredLabel = hasAssessments ? 'Quality: no qualifying score' : 'Quality: not assessed';
  const label = quality?.unavailable ? 'Quality unavailable'
    : score == null ? unscoredLabel : `Quality: ${score}/100`;
  if (!detail) return (
    <Link to={`/apps/${app.id}/quality`} className="text-xs text-port-accent hover:underline" title="View audit scores and coverage">
      {label}{score != null && ` · ${quality.ratedCategories}/${quality.totalCategories} categories`}
    </Link>
  );
  return (
    <AppQualityRunner key={app.id} app={app}>{runner => <section aria-label="App quality" className="bg-port-card border border-port-border rounded-lg p-4 space-y-3">
      <h3 className="font-semibold text-white">{label}</h3>
      <p className="text-xs text-gray-400">
        Assessments describe the code before fixes. The overall score is the equal-weight mean of broad, medium/high-confidence assessments from the last 30 days.
        {' '}{quality?.ratedCategories ?? 0}/{quality?.totalCategories ?? 0} categories contribute. Missing, partial, low-confidence and stale assessments are excluded, not counted as perfect.
      </p>
      {quality?.federation && (
        <p className="text-xs text-gray-400">
          Unified PortOS score: newest assessment per category across this install and {quality.federation.available ?? 0} available full-sync peers with the same repository. Versions may differ.
          {' '}Peer evidence is fetched when viewed; offline peers do not contribute.
          {quality.federation.failed && ' Peer quality could not be loaded; the score may be incomplete.'}
          {quality.federation.unavailable > 0 && ` ${quality.federation.unavailable} peers unavailable or incompatible; the score may be incomplete.`}
        </p>
      )}
      {score == null && !quality?.unavailable && (
        <p className="text-sm text-gray-400">
          {hasAssessments
            ? 'Saved assessments do not currently qualify for an overall score. Check the category breakdown for coverage, confidence and age.'
            : 'No audit assessment has been saved. Completed maintenance tasks only supply a score when they return a valid quality report. Earlier runs are not scored retroactively; run a scheduled audit to collect an assessment.'}
        </p>
      )}
      <div className="flex flex-wrap gap-4 text-sm text-port-accent"><Link to="/cos/schedule" className="hover:underline">Scheduled audit runners</Link><Link to="/cos/agents" className="hover:underline">View agents</Link></div>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5 items-start">
      <div className="min-w-0 space-y-4">
        {!selectedCategory && runner}
        <AppQualityHistory appId={app.id} categories={quality?.categories} />
      </div>
      {!!quality?.categories?.length && (
        <section aria-label="Category breakdown" className="min-w-0">
          <h4 className="text-sm font-medium mb-2">Category breakdown</h4>
          <table className="w-full text-sm text-left">
            <thead className="text-gray-400 sticky top-0 bg-port-card"><tr><th className="py-2 pr-3">Category</th><th className="pr-3">Score</th><th>Evidence</th></tr></thead>
            <tbody>{quality.categories.map(category => (
              <Fragment key={category.id}><tr className="border-t border-port-border align-top">
                <th scope="row" className="py-2 pr-3 font-medium">{category.label}<Link className="block text-xs font-normal text-port-accent hover:underline" to={`/cos/schedule?task=${encodeURIComponent(category.id)}`} aria-label={`${category.label} runner`}>Runner settings</Link></th>
                <td className="py-2 pr-3 whitespace-nowrap">{category.score == null ? '—' : `${category.score}/100`}</td>
                <td className="py-2 text-xs text-gray-400">
                  <div>{category.stale ? 'Stale · ' : ''}{category.coverage}{category.confidence && ` · ${category.confidence} confidence`}
                    {category.assessedAt && ` · ${formatDateShort(category.assessedAt)}`}</div>
                  <Link to={runnerLink(category.id)} aria-label={`Configure and run ${category.label}`} className="block mt-1 text-port-accent hover:underline">Configure and run</Link>
                  {category.summary && <details className="mt-1"><summary className="cursor-pointer text-port-accent">Assessment details</summary><p className="break-words">{category.summary}</p></details>}
                  {category.totalFiles > 0 && <div>{category.scannedFiles}/{category.totalFiles} files scanned · Worst severity: {category.worstSeverity}/10</div>}
                  {category.sourcePeerId && <div>Source: {category.sourcePeerName || 'federated peer'} · <Link className="text-port-accent hover:underline" to="/instances">View instances</Link></div>}
                  {!category.sourcePeerId && category.agentId && <Link className="text-port-accent hover:underline" to={`/cos/agents/${category.agentId}`}>Audit run</Link>}
                </td>
              </tr>
              {selectedCategory?.id === category.id && <tr><td colSpan={3} className="pb-3">
                {runner}
              </td></tr>}
              </Fragment>
            ))}</tbody>
          </table>
        </section>
      )}
      </div>
    </section>}</AppQualityRunner>
  );
}
