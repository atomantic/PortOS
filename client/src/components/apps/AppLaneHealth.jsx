import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { getAppLaneHealth } from '../../services/apiApps';
import { formatCount, formatDateShort } from '../../utils/formatters';
import InfoTooltip from '../ui/InfoTooltip';

const UNAVAILABLE = {
  'forge-unavailable': 'This app has no GitHub or GitLab tracker, so there is no issue record to read.',
  issues: 'The tracker could not be read.',
};

// A lane's noise is what it got wrong or repeated; filed breaks ties so the
// busiest noisy lane sits first.
const noise = (lane) => lane.notPlanned + lane.reverted + lane.refiled;
const describeFlag = (reason) => {
  if (reason.kind === 'not-planned') return reason.stateReason === 'duplicate' ? 'duplicate' : 'not planned';
  if (reason.kind === 'reverted') return reason.pullRequest != null ? `reverted (PR #${reason.pullRequest})` : 'reverted';
  if (reason.kind === 're-filed') return reason.of != null ? `re-filed after #${reason.of}` : 're-filed';
  return 'flagged';
};

/** Per-lane outcome of the issues each audit lane filed (#12088): a read on request, never polled. */
export default function AppLaneHealth({ appId }) {
  const [state, setState] = useState({ loading: true });
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setState({ loading: true });
    getAppLaneHealth(appId).then((data) => {
      if (active) setState({ data });
    }).catch(() => {
      if (active) setState({ error: true });
    });
    return () => { active = false; };
  }, [appId, refresh]);
  const data = state.data;
  const lanes = (data?.lanes || []).filter((lane) => lane.filed > 0)
    .sort((a, b) => noise(b) - noise(a) || b.filed - a.filed || a.label.localeCompare(b.label));
  return (
    <section aria-label="Lane health" className="bg-port-card border border-port-border rounded-lg p-4 space-y-3 min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="flex items-center gap-1.5 text-sm font-medium">
          Lane health
          <InfoTooltip label="About lane health" placement="below" align="start" width={300}>
            What became of the issues each audit lane filed in the last {data?.windowDays ?? 60} days, read from the tracker. Not planned counts issues closed as not planned or duplicate; reverted counts fixes a later <code>Revert</code> commit undid; re-filed counts issues citing a file a closed finding of the same lane cited within {data?.refileDays ?? 30} days. Each lane sees its own row before it runs, so it does not repeat a rejected finding.
          </InfoTooltip>
        </h4>
        <button type="button" aria-label="Refresh lane health" title="Refresh lane health" className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center text-gray-400 hover:text-port-accent" onClick={() => setRefresh((n) => n + 1)}>
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      </div>
      {state.loading ? <p role="status">Loading lane health…</p>
        : state.error ? <p role="alert">Lane health could not be loaded. Use Refresh lane health to retry.</p>
        : data?.available === false ? <p className="text-sm text-gray-400">{UNAVAILABLE[data.reason] || 'Lane health is unavailable.'}{data.error ? ` ${data.error}` : ''}</p>
        : !lanes.length ? <p className="text-sm text-gray-400">No audit lane filed an issue in the last {data.windowDays} days.</p>
        : <>
          {(data.truncated || data.partial?.length > 0) && <p className="text-xs text-port-warning">
            {data.truncated ? `The tracker read was truncated; counts cover issues filed since ${formatDateShort(data.from)}. ` : ''}
            {data.partial?.length > 0 ? `${data.partial.join(' and ')} could not be read, so reverted counts are incomplete.` : ''}
          </p>}
          <div className="overflow-x-auto"><table className="w-full text-left text-sm" aria-label="Audit lane outcomes">
            <thead className="text-xs text-gray-400"><tr>
              <th scope="col" className="py-1.5 px-2">Lane</th>
              <th scope="col" className="py-1.5 px-2 text-right">Filed</th>
              <th scope="col" className="py-1.5 px-2 text-right">Completed</th>
              <th scope="col" className="py-1.5 px-2 text-right">Not planned</th>
              <th scope="col" className="py-1.5 px-2 text-right">Reverted</th>
              <th scope="col" className="py-1.5 px-2 text-right">Re-filed</th>
            </tr></thead>
            <tbody>{lanes.map((lane) => <tr key={lane.id} className={`border-t border-port-border${noise(lane) > 0 ? ' bg-port-warning/10' : ''}`}>
              <th scope="row" className="py-1.5 px-2 font-medium">
                <span className="inline-flex items-center gap-1.5">
                  {lane.label}
                  {lane.flagged?.length > 0 && <InfoTooltip label={`${lane.label} findings that were rejected, reverted or repeated`} placement="below" align="start" width={320} panelClassName="font-normal">
                    <ul className="space-y-1">{lane.flagged.map((item) => <li key={item.number} className="break-words">
                      {item.url ? <a href={item.url} target="_blank" rel="noreferrer" className="text-port-accent hover:underline">#{item.number}</a> : `#${item.number}`} {item.title} · {item.reasons.map(describeFlag).join('; ')}
                    </li>)}</ul>
                    {lane.flaggedTotal > lane.flagged.length && <p className="mt-1 text-gray-400">{formatCount(lane.flaggedTotal - lane.flagged.length)} more not shown</p>}
                  </InfoTooltip>}
                </span>
              </th>
              <td className="py-1.5 px-2 text-right tabular-nums">{formatCount(lane.filed)}</td>
              <td className="py-1.5 px-2 text-right tabular-nums">{formatCount(lane.completed)}</td>
              <td className="py-1.5 px-2 text-right tabular-nums">{formatCount(lane.notPlanned)}</td>
              <td className="py-1.5 px-2 text-right tabular-nums">{formatCount(lane.reverted)}</td>
              <td className="py-1.5 px-2 text-right tabular-nums">{formatCount(lane.refiled)}</td>
            </tr>)}</tbody>
          </table></div>
        </>}
    </section>
  );
}
