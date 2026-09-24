import AppQualityRunner from './AppQualityRunner';
import AppQualityHistory from './AppQualityHistory';
import AppQualityScheduleForm from './AppQualityScheduleForm';
import { useId, useState } from 'react';
import { CalendarClock, Play } from 'lucide-react';
import { Link, useSearchParams } from 'react-router';
import { formatDateShort } from '../../utils/formatters';
import { publishAppQualitySnapshot } from '../../services/apiApps';
import toast from '../ui/Toast';
import InfoTooltip from '../ui/InfoTooltip';
import OverflowMenu from '../ui/OverflowMenu';
import Drawer from '../Drawer';
import useDrawerTab from '../../hooks/useDrawerTab';

// Run/schedule forms live in a slide-out keyed by ?qualityPanel so the page
// itself stays a metrics view; the value is the drawer title.
const PANELS = { run: 'Run quality checks', schedule: 'Weekly quality schedule' };

// The server refuses rather than fails when there is nothing to publish, so each
// `published: false` reason gets its own plain-language explanation.
const PUBLISH_SKIPPED = {
  'no-changes': 'Snapshot already up to date in .quality.json',
  'no-evidence': 'No quality evidence yet — run an audit first',
  'no-repo-path': 'App repo path is not a git repository',
  'not-a-repo': 'App repo path is not a git repository',
  'no-remote': 'App repo has no origin remote to open a pull request against',
  'no-default-branch': 'Could not resolve the repository default branch',
  'pr-failed': 'Could not open a quality snapshot pull request',
  'unsupported-format': 'The committed quality file is in an unsupported format. Publish left it in place.',
  'invalid-evidence': 'The current measurements could not be written as a snapshot. Publish left the file in place.',
};

export default function AppQuality({ app, detail = false }) {
  const [params] = useSearchParams();
  const [publishing, setPublishing] = useState(false);
  const [categorySort, setCategorySort] = useState('score');
  const categorySortId = useId();
  const [panel, setPanel] = useDrawerTab('qualityPanel', null, Object.keys(PANELS));
  // User-initiated, so every outcome toasts (the wrapper is silent).
  const publishSnapshot = async () => {
    setPublishing(true);
    const result = await publishAppQualitySnapshot(app.id).catch(err => ({ failure: err }));
    setPublishing(false);
    if (result?.failure) return toast.error(result.failure.message || 'Could not publish the quality snapshot');
    if (result?.published) {
      return toast.success(result.prUrl
        ? 'Quality snapshot pull request opened; it merges immediately'
        : 'Quality snapshot published to .quality.json');
    }
    toast(PUBLISH_SKIPPED[result?.reason] || 'Nothing to publish to .quality.json');
  };
  const quality = app.quality;
  const score = quality?.score;
  const sortedCategories = quality?.categories
    ? [...quality.categories].sort((a, b) => {
      // Categories that cannot apply to this repository sink below every
      // category that can, whichever sort is active.
      if ((a.applicable === false) !== (b.applicable === false)) return a.applicable === false ? 1 : -1;
      if (categorySort === 'oldest-run') {
        const aRun = Date.parse(a.assessedAt);
        const bRun = Date.parse(b.assessedAt);
        const aHasRun = Number.isFinite(aRun);
        const bHasRun = Number.isFinite(bRun);
        if (aHasRun !== bHasRun) return aHasRun ? 1 : -1;
        if (aHasRun && aRun !== bRun) return aRun - bRun;
      } else {
        const aScore = a.score ?? Infinity;
        const bScore = b.score ?? Infinity;
        if (aScore !== bScore) return aScore < bScore ? -1 : 1;
      }
      return a.label.localeCompare(b.label) || a.id.localeCompare(b.id);
    })
    : [];
  // Pre-applicability servers send no `applicableCategories`; fall back to the catalog size.
  const categoryCount = quality?.applicableCategories ?? quality?.totalCategories ?? 0;
  const hasAssessments = quality?.categories?.some(category => category.assessedAt);
  const unscoredLabel = hasAssessments ? 'Quality: no qualifying score' : 'Quality: not assessed';
  const label = quality?.unavailable ? 'Quality unavailable'
    : score == null ? unscoredLabel : `Quality: ${score}/100`;
  if (!detail) return (
    <Link to={`/apps/${app.id}/quality`} className="text-xs text-port-accent hover:underline" title="View audit scores and coverage">
      {label}{score != null && ` · ${quality.ratedCategories} rated`}
    </Link>
  );
  const panelLink = (name, categoryId) => {
    const next = new URLSearchParams(params);
    next.set('qualityPanel', name);
    // Header actions open on the default selection; a row's Run preselects it.
    if (categoryId) next.set('qualityCheck', categoryId);
    else next.delete('qualityCheck');
    return { search: next.toString() };
  };
  const menuItems = [
    { id: 'runners', label: 'Scheduled audit runners', to: '/cos/schedule' },
    { id: 'agents', label: 'View agents', to: '/cos/agents' },
    ...(app.publishQualitySnapshot === true
      ? [{ id: 'publish', label: publishing ? 'Publishing snapshot…' : 'Publish snapshot now', onSelect: publishSnapshot, disabled: publishing }]
      : []),
  ];
  const federation = quality?.federation;
  return (
    <AppQualityRunner key={app.id} app={app}>{(runner, activeRuns) => <section aria-label="App quality" className="space-y-4">
      <div className="bg-port-card border border-port-border rounded-lg p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4 min-w-0">
          <div className="text-4xl font-semibold tabular-nums text-white" aria-hidden="true">
            {score ?? '—'}<span className="text-base font-normal text-gray-500">/100</span>
          </div>
          <div className="min-w-0">
            <h3 className="flex items-center gap-1.5 font-semibold text-white">
              {label}
              <InfoTooltip label="How the quality score works" placement="below" align="start" panelClassName="w-80">
                <p>Equal-weight mean of broad, medium/high-confidence assessments from the last 30 days. Missing, partial, low-confidence and stale assessments are excluded, not counted as perfect. Assessments describe the code before fixes.</p>
                <p className="mt-1.5">Scores are the auditing agent’s evidence-based judgment, not an issue count: 90–100 no material defect · 70–89 localized debt · 40–69 significant problems · 10–39 severe defects · 0–9 pervasive failure. A run with no findings can score below 100.</p>
                {federation && <p className="mt-1.5">Unified score: the newest assessment per category across this install and sync peers with the same repository. Offline peers do not contribute.</p>}
                {score == null && !hasAssessments && <p className="mt-1.5">Maintenance tasks only supply a score when they return a valid quality report. Earlier runs are not scored retroactively.</p>}
              </InfoTooltip>
            </h3>
            <p className="text-xs text-gray-400">
              {quality?.ratedCategories ?? 0}/{categoryCount} applicable categories contribute
              {federation && ` · ${federation.available ?? 0} sync peers`}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link to={panelLink('run')} className="inline-flex items-center gap-1.5 rounded bg-port-accent px-3 py-1.5 text-xs font-medium text-port-bg hover:opacity-90">
            <Play size={14} aria-hidden="true" />Run checks
            {activeRuns > 0 && <span className="rounded-full bg-port-bg/30 px-1.5">{activeRuns} running</span>}
          </Link>
          <Link to={panelLink('schedule')} className="inline-flex items-center gap-1.5 rounded border border-port-border bg-port-bg/60 px-3 py-1.5 text-xs font-medium text-gray-200 hover:border-port-accent hover:text-white">
            <CalendarClock size={14} aria-hidden="true" />Schedule
          </Link>
          <OverflowMenu label="More quality actions" items={menuItems} />
        </div>
        {(federation?.failed || federation?.unavailable > 0) && <p className="basis-full text-xs text-port-warning">
          {federation.failed ? 'Peer quality could not be loaded; the score may be incomplete.' : `${federation.unavailable} peers unavailable or incompatible; the score may be incomplete.`}
        </p>}
        {score == null && !quality?.unavailable && <p className="basis-full text-sm text-gray-400">
          {hasAssessments ? 'Saved assessments do not qualify for an overall score yet. See the breakdown for coverage, confidence and age.' : 'No audit assessment saved yet. Run checks to collect one.'}
        </p>}
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
        <AppQualityHistory appId={app.id} categories={quality?.categories} />
        {!!quality?.categories?.length && (
          <section aria-label="Category breakdown" className="min-w-0 bg-port-card border border-port-border rounded-lg p-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-sm font-medium">Category breakdown</h4>
              <label htmlFor={categorySortId} className="flex items-center gap-2 text-xs text-gray-400">
                Sort by
                <select
                  id={categorySortId}
                  value={categorySort}
                  onChange={event => setCategorySort(event.target.value)}
                  className="rounded border border-port-border bg-port-bg px-2 py-1 text-port-text"
                >
                  <option value="score">Worst score</option>
                  <option value="oldest-run">Oldest last run</option>
                </select>
              </label>
            </div>
            <table className="w-full text-sm text-left">
              <thead className="text-xs text-gray-400">
                <tr>
                  <th className="py-1.5 px-2">Category</th>
                  <th className="py-1.5 px-2">Score</th>
                  <th className="py-1.5 px-2 hidden sm:table-cell">Evidence</th>
                  <th className="py-1.5 px-2"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>{sortedCategories.map(category => <CategoryRow key={category.id} category={category}
                below={score != null && category.score != null && category.coverage !== 'not-applicable' && category.score < score}
                runLink={panelLink('run', category.id)} />)}</tbody>
            </table>
          </section>
        )}
      </div>
      <Drawer open={!!panel} onClose={() => setPanel(null)} title={PANELS[panel]} size="md" closeLabel="Close"
        // The schedule form holds an unapplied plan; a stray Esc/backdrop click would discard it.
        closeOnEsc={panel !== 'schedule'} closeOnBackdrop={panel !== 'schedule'}>
        {panel === 'run' && runner}
        {panel === 'schedule' && <AppQualityScheduleForm app={app} />}
      </Drawer>
    </section>}</AppQualityRunner>
  );
}

function CategoryRow({ category, below, runLink }) {
  const details = category.summary || category.totalFiles > 0 || category.id === 'better-dependency-freedom';
  const menuItems = [
    { id: 'settings', label: 'Runner settings', to: `/cos/schedule?task=${encodeURIComponent(category.id)}` },
    ...(!category.sourcePeerId && category.agentId ? [{ id: 'run', label: 'View audit run', to: `/cos/agents/${category.agentId}` }] : []),
    ...(category.sourcePeerId ? [{ id: 'instances', label: 'View instances', to: '/instances' }] : []),
  ];
  const inapplicable = category.applicable === false;
  const evidence = inapplicable ? <>Not applicable · {category.inapplicableReason}</> : <>
    {category.stale ? 'Stale · ' : ''}{category.coverage}{category.confidence && ` · ${category.confidence}`}
    {category.assessedAt && ` · ${formatDateShort(category.assessedAt)}`}
    {category.sourcePeerId || category.sourcePeerName ? ` · ${category.sourcePeerName || 'federated peer'}` : ''}
  </>;
  return (
    <tr className={`border-t border-port-border align-middle${below ? ' bg-port-warning/10' : ''}${inapplicable ? ' text-gray-500' : ''}`}>
      <th scope="row" className="py-1.5 px-2 font-medium">
        <span className="inline-flex items-center gap-1.5">
          {category.label}
          {details && <InfoTooltip label={`${category.label} assessment details`} placement="below" align="start" panelClassName="w-72 max-h-64 overflow-auto font-normal">
            {category.summary && <p className="break-words">{category.summary}</p>}
            {category.totalFiles > 0 && <p className="mt-1">{category.scannedFiles}/{category.totalFiles} files scanned · Worst severity: {category.worstSeverity}/10</p>}
            {category.id === 'better-dependency-freedom' && <p className="mt-1">Assesses whether packages earn their place; dependency count carries no automatic penalty.</p>}
          </InfoTooltip>}
        </span>
      </th>
      <td className="py-1.5 px-2 tabular-nums">
        <span className="whitespace-nowrap">{category.score == null ? '—' : `${category.score}/100`}</span>
        <span className="block text-xs text-gray-400 sm:hidden">{evidence}</span>
      </td>
      <td className="py-1.5 px-2 text-xs text-gray-400 hidden sm:table-cell">{evidence}</td>
      <td className="py-1.5 px-2">
        <div className="flex items-center justify-end gap-1">
          <Link to={runLink} aria-label={`Run ${category.label} check`} title="Run this check"
            className="inline-flex min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 items-center justify-center rounded border border-port-accent/60 bg-port-accent/10 p-1.5 text-port-accent hover:bg-port-accent/25">
            <Play size={12} aria-hidden="true" />
          </Link>
          <OverflowMenu label={`${category.label} actions`} items={menuItems} />
        </div>
      </td>
    </tr>
  );
}
