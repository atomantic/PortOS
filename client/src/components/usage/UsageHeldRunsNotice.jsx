import { Link } from 'react-router';
import { formatCount, timeAgo } from '../../utils/formatters';

const plural = (count, noun) => `${formatCount(count)} ${noun}${count === 1 ? '' : 's'}`;

/** Standalone usage the interactive scan will not bill until a run's end is provable. */
export default function UsageHeldRunsNotice({ held = null }) {
  if (!held) return null;
  return (
    <div role="note" aria-label="Standalone usage on hold" className="rounded-lg border border-port-warning/30 bg-port-warning/5 p-3 text-xs space-y-2">
      <p className="font-medium text-port-warning">Some standalone usage is on hold behind {plural(held.runs, 'PortOS run')} with no recorded end, since {timeAgo(held.since, 'an unknown time')}.</p>
      <p className="text-gray-400">PortOS cannot prove these runs stopped, so terminal sessions in their workspaces may belong to them and are left out of totals. Other workspaces are unaffected. The held usage is counted automatically once a run’s end is recorded, as long as the CLI’s own session files remain.</p>
      <ul className="text-gray-400 break-words">
        {held.workspaces.map(({ workspace, runs, since }) => <li key={`${workspace}:${since}`}>{workspace}: {plural(runs, 'run')}, since {timeAgo(since, 'an unknown time')}</li>)}
        {held.moreWorkspaces > 0 && <li>and {plural(held.moreWorkspaces, 'more workspace')}</li>}
      </ul>
      <Link className="inline-flex min-h-11 items-center rounded-lg border border-port-border px-3 text-port-text hover:border-port-accent" to="/cos/runs">Review runs</Link>
    </div>
  );
}
