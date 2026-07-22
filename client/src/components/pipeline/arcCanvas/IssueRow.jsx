import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Trash2 } from 'lucide-react';
import toast from '../../ui/Toast';
import ConfirmButtonPair from '../../ui/ConfirmButtonPair';
import { timeAgo } from '../../../utils/formatters';
import { deletePipelineIssue, updatePipelineIssue } from '../../../services/api';
import CoverArt from './CoverArt.jsx';

const ISSUE_STATUS_COLORS = {
  draft: 'text-gray-400 bg-gray-700/30',
  running: 'text-port-accent bg-port-accent/10',
  'needs-review': 'text-port-warning bg-port-warning/10',
  shipped: 'text-port-success bg-port-success/10',
};

function issueCoverRecord(issue) {
  return issue?.stages?.comicPages?.cover || null;
}

export default function IssueRow({ issue, seasons, onIssuesUpdate }) {
  const [reassigning, setReassigning] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const cover = issueCoverRecord(issue);

  const runDelete = async () => {
    setConfirmingDelete(false);
    const ok = await deletePipelineIssue(issue.id, { silent: true }).catch((err) => {
      toast.error(err.message || 'Delete failed');
      return null;
    });
    if (ok == null) return;
    onIssuesUpdate((prev) => prev.filter((i) => i.id !== issue.id));
  };

  const handleReassign = async (newSeasonId) => {
    if (newSeasonId === (issue.seasonId || '')) return;
    setReassigning(true);
    const patched = await updatePipelineIssue(issue.id, {
      seasonId: newSeasonId || null,
    }, { silent: true }).catch((err) => {
      toast.error(err.message || 'Reassign failed');
      return null;
    });
    setReassigning(false);
    if (!patched) return;
    onIssuesUpdate((prev) => prev.map((i) => i.id === issue.id ? patched : i));
  };

  return (
    <li className="group rounded border border-port-border bg-port-bg/50 overflow-hidden hover:border-port-accent/50 transition-colors">
      <Link
        to={`/pipeline/issues/${issue.id}/idea`}
        className="block"
      >
        <div className="aspect-[3/4] bg-port-bg">
          <CoverArt
            record={cover}
            label={`${issue.title || 'Untitled'} cover`}
            className="rounded-none border-0"
            placeholderClassName="rounded-none border-0"
          />
        </div>
        <div className="p-2 space-y-1 min-h-[86px]">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-gray-500 font-mono">
              {issue.arcPosition ? `E${issue.arcPosition}` : `#${issue.number}`}
            </span>
            <span className={`text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded ${ISSUE_STATUS_COLORS[issue.status] || ISSUE_STATUS_COLORS.draft}`}>
              {issue.status}
            </span>
          </div>
          <p className="text-sm text-white font-medium line-clamp-2">{issue.title || 'Untitled'}</p>
          <p className="text-[10px] text-gray-600">updated {timeAgo(issue.updatedAt)}</p>
        </div>
      </Link>
      {confirmingDelete ? (
        <div className="px-2 pb-2">
          <ConfirmButtonPair
            prompt="Delete?"
            className="justify-end"
            ariaLabel={`Confirm delete ${issue.title}`}
            onConfirm={runDelete}
            onCancel={() => setConfirmingDelete(false)}
          />
        </div>
      ) : (
        <div className="px-2 pb-2 flex items-center gap-1.5">
          <select
            value={issue.seasonId || ''}
            onChange={(e) => handleReassign(e.target.value)}
            disabled={reassigning}
            title="Move to a different season"
            className="min-w-0 flex-1 text-[10px] bg-port-card border border-port-border rounded text-gray-300 opacity-70 group-hover:opacity-100 focus:opacity-100"
          >
            <option value="">— ungrouped —</option>
            {seasons.map((s) => (
              <option key={s.id} value={s.id}>V{s.number}: {s.title}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setConfirmingDelete(true)}
            className="p-1 rounded border border-port-border bg-port-card text-gray-500 hover:text-port-error opacity-70 group-hover:opacity-100 focus:opacity-100"
            aria-label={`Delete ${issue.title}`}
            title="Delete issue / episode"
          >
            <Trash2 size={12} />
          </button>
        </div>
      )}
    </li>
  );
}
