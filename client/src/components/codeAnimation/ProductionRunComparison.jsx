import { formatBytes, formatCount, formatRuntime } from '../../utils/formatters';

const DIMENSIONS = [['technical', 'Technical'], ['visual', 'Visual'], ['temporal', 'Temporal'], ['sound', 'Sound']];
const STATUS_STYLE = { verified: 'text-port-success', partial: 'text-port-warning', failed: 'text-port-error', unverified: 'text-gray-400' };

/** Four evidence dimensions, drawn apart: a partial or unverified dimension never reads as a pass. */
export function EvidenceGrid({ evidence }) {
  return <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2" aria-label="Evidence">
    {DIMENSIONS.map(([key, label]) => {
      const entry = evidence[key];
      return <div key={key} className="min-w-0 rounded border border-port-border p-2 text-xs">
        <dt className="flex justify-between gap-2"><span className="font-medium">{label}</span><span className={STATUS_STYLE[entry.status]}>{entry.status}</span></dt>
        <dd className="space-y-1 text-gray-400">
          {entry.verified.length > 0 && <p>Measured: {entry.verified.join(', ')}</p>}
          {entry.findings.map((finding, index) => <p key={index} className={finding.severity === 'error' ? 'text-port-error' : 'text-port-warning'}>[{finding.severity}] {finding.detail}</p>)}
          {entry.unverified.map(item => <p key={item.dimension} className="border-l border-dashed border-port-warning pl-2">Unverified: {item.reason}</p>)}
        </dd>
      </div>;
    })}
  </dl>;
}

const route = settings => settings ? [settings.providerId, settings.model].filter(Boolean).join(' · ') || 'Unspecified' : 'Not recorded';

function RunColumn({ run }) {
  const first = run.frames[0]?.revisionId;
  const before = run.frames.filter(frame => frame.revisionId === first);
  const after = run.frames.filter(frame => frame.revisionId !== first);
  const pilot = run.pilots.at(-1);
  return <article className="min-w-0 space-y-3 rounded border border-port-border p-3" aria-label={`Run ${run.runId.slice(0, 8)}`}>
    <h4 className="text-sm font-medium">Run {run.runId.slice(0, 8)} · {run.status}{run.accepted ? ' · accepted' : ''}</h4>
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
      <dt className="text-gray-400">Requested route</dt><dd className="min-w-0 break-words">{route(run.settings.requested)}</dd>
      <dt className="text-gray-400">Effective route</dt><dd className="min-w-0 break-words">{route(run.settings.effective)}</dd>
      <dt className="text-gray-400">Model effort</dt><dd>{run.settings.effective?.effort || run.settings.requested?.effort || 'unspecified'} (authoring reasoning budget)</dd>
      {run.settings.renderer && <><dt className="text-gray-400">Renderer</dt><dd className="min-w-0 break-words">Blender {run.settings.renderer.version} · {run.settings.renderer.engine} · {run.settings.renderer.device}</dd></>}
      <dt className="text-gray-400">Budgets</dt><dd>{run.budgets ? `${formatCount(run.budgets.iterations)} repairs · ${formatCount(run.budgets.tokens)} tokens · ${formatCount(run.budgets.renderSeconds)}s render` : 'Not recorded'}</dd>
      <dt className="text-gray-400">Spent</dt><dd>{formatCount(run.spend.repairs)} repairs · {formatCount(run.spend.tokens)} tokens · {formatRuntime(run.spend.renderMs)} render · {formatRuntime(run.spend.elapsedMs)} elapsed · {formatBytes(run.spend.diskBytes)}</dd>
      <dt className="text-gray-400">Verdict</dt><dd>{run.verdict?.status || 'none'}{run.reviewer ? ` · reviewed by ${run.reviewer.providerId}` : ''}</dd>
    </dl>
    <EvidenceGrid evidence={run.evidence} />
    {run.findings.length > 0 && <ol className="space-y-1 text-xs" aria-label="Timestamped findings">
      {run.findings.map((finding, index) => <li key={index} className={finding.severity === 'error' ? 'text-port-error' : 'text-port-warning'}>
        <span className="tabular-nums">{finding.atSeconds != null ? `${formatCount(finding.atSeconds, { maximumFractionDigits: 2 })}s` : 'whole film'}</span> · {finding.kind}: {finding.detail}
      </li>)}
    </ol>}
    {run.repairs.length > 0 && <p className="text-xs text-gray-400">{formatCount(run.repairs.length)} repair revision{run.repairs.length === 1 ? '' : 's'}: {run.repairs.map(repair => repair.findingKinds.join('+')).join(' → ')}</p>}
    {before.length > 0 && <div className="space-y-1 text-xs"><p className="text-gray-400">{after.length ? 'Before repair' : 'Style frames'}</p>
      <div className="flex flex-wrap gap-2">{before.map(frame => <img key={frame.path} src={frame.path} alt={`Style frame at ${frame.atSeconds}s`} className="h-20 w-auto max-w-full rounded border border-port-border" />)}</div></div>}
    {after.length > 0 && <div className="space-y-1 text-xs"><p className="text-gray-400">After repair</p>
      <div className="flex flex-wrap gap-2">{after.map(frame => <img key={frame.path} src={frame.path} alt={`Repaired style frame at ${frame.atSeconds}s`} className="h-20 w-auto max-w-full rounded border border-port-border" />)}</div></div>}
    {pilot?.video
      ? <video aria-label={`Motion pilot for run ${run.runId.slice(0, 8)}`} controls preload="none" src={pilot.video} className="w-full min-w-0 rounded" />
      : pilot && <p className="text-xs text-gray-400">The browser pilot measured {formatCount(pilot.samples)} sampled frames; it produces no video to play.</p>}
    {run.output?.path && <video aria-label={`Final video for run ${run.runId.slice(0, 8)}`} controls preload="none" src={run.output.path} className="w-full min-w-0 rounded" />}
    {run.error && <p role="status" className="text-xs text-port-error">{run.error.message}</p>}
  </article>;
}

/** One or two selected runs, side by side. The selection lives in the URL, so a comparison can be shared. */
export default function ProductionRunComparison({ runs }) {
  if (!runs.length) return null;
  return <section aria-label="Run comparison" className={`grid grid-cols-1 gap-3 ${runs.length > 1 ? 'lg:grid-cols-2' : ''}`}>
    {runs.map(run => <RunColumn key={run.runId} run={run} />)}
  </section>;
}
