import { useSearchParams } from 'react-router';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { useSocketResource } from '../../hooks/useSocketResource';
import { acceptCodeAnimationOutput, getCodeAnimationAcceptance } from '../../services/apiCodeAnimation';
import { timeAgo } from '../../utils/formatters';
import ProductionRunComparison, { EvidenceGrid } from './ProductionRunComparison';

const EVENTS = ['code-animation:changed'];
const buttonClass = 'rounded border border-port-border px-3 py-2 text-sm hover:border-port-accent disabled:opacity-50';
const MAX_COMPARE = 2;

/**
 * The accepted output, its frozen evidence, and run comparison. Accepted playback is
 * read separately from the run list, so a newer failed run never hides it.
 */
export default function ProductionAcceptance({ projectId, disabled, onProject, onDownloadSource }) {
  const [params, setParams] = useSearchParams();
  const [act, busy] = useAsyncAction(async operation => operation());
  const resource = useSocketResource(({ signal }) => getCodeAnimationAcceptance(projectId, { signal, silent: true }), {
    namespace: 'code-animation', events: EVENTS, resourceKey: projectId, matchesEvent: payload => payload?.id === projectId,
  });
  const data = resource.data;
  if (!data) return resource.error ? <p role="alert" className="text-xs text-port-error">{resource.error.message}</p> : null;
  const { accepted, runs } = data;
  const chosen = (params.get('compare') || '').split(',').filter(Boolean);
  const selected = chosen.map(id => runs.find(run => run.runId === id)).filter(Boolean);
  const toggle = runId => {
    const next = new URLSearchParams(params);
    const ids = chosen.includes(runId) ? chosen.filter(id => id !== runId) : [...chosen, runId].slice(-MAX_COMPARE);
    if (ids.length) next.set('compare', ids.join(',')); else next.delete('compare');
    setParams(next, { replace: true });
  };
  const promote = runId => act(async () => {
    onProject(await acceptCodeAnimationOutput(projectId, runId, { silent: true }));
    await resource.refetch();
  });
  return <section className="space-y-3 rounded border border-port-border p-3" aria-label="Production acceptance">
    <h3 className="text-sm font-semibold">Accepted output</h3>
    {accepted ? <div className="min-w-0 space-y-2">
      <video aria-label="Accepted final video" controls preload="none" src={accepted.path} className="w-full min-w-0 rounded" />
      <p className="text-xs text-gray-400">Accepted {timeAgo(accepted.acceptedAt)} from run {accepted.runId.slice(0, 8)} · frozen to source {accepted.sourceHash.slice(0, 12)}, render {accepted.renderHash.slice(0, 12)}{accepted.audioHash ? `, audio ${accepted.audioHash.slice(0, 12)}` : ', silent audio'}</p>
      {!accepted.fresh && <div role="alert" className="space-y-1 rounded border border-port-warning p-2 text-xs text-port-warning">
        <p>Earlier passing evidence is stale. The accepted video still plays, but it is no longer verified.</p>
        {accepted.stale.map(item => <p key={item.dimension}>{item.reason}</p>)}
      </div>}
      <EvidenceGrid evidence={accepted.evidence} />
      <div className="flex flex-wrap gap-2">
        <button type="button" className={buttonClass} disabled={disabled || busy} onClick={() => onDownloadSource(accepted.revisionId)}>Download source bundle</button>
        <a className={`${buttonClass} inline-block`} href={accepted.path} download>Download accepted MP4</a>
      </div>
      <p className="text-xs text-gray-400">This video is in Media History as <code>{accepted.videoId}</code>; Music Video Studio and Creative Director can use it without a song or episode project.</p>
    </div> : <p className="text-xs text-gray-400">No output has been accepted. Accept a passing run below; failed runs never replace an accepted output.</p>}
    <h3 className="text-sm font-semibold">Runs to compare</h3>
    {runs.length === 0 && <p className="text-xs text-gray-400">Run production stages to produce evidence.</p>}
    <ul className="space-y-2">
      {runs.map(run => <li key={run.runId} className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <label htmlFor={`cap-compare-${run.runId}`} className="flex min-w-0 items-center gap-2">
          <input id={`cap-compare-${run.runId}`} type="checkbox" checked={chosen.includes(run.runId)} onChange={() => toggle(run.runId)} />
          <span className="min-w-0 break-words">Run {run.runId.slice(0, 8)} · {run.status} · verdict {run.verdict?.status || 'none'} · {timeAgo(run.createdAt)}{run.accepted ? ' · accepted' : ''}</span>
        </label>
        {run.acceptable && !run.accepted && <button type="button" className={buttonClass} disabled={disabled || busy} onClick={() => promote(run.runId)}>Accept output of run {run.runId.slice(0, 8)}</button>}
      </li>)}
    </ul>
    <p className="text-xs text-gray-400">Choose up to two runs to compare.</p>
    <ProductionRunComparison runs={selected} />
  </section>;
}
