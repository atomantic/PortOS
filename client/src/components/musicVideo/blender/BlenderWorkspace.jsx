import { ClipboardCopy, FolderPlus } from 'lucide-react';
import { copyToClipboard } from '../../../lib/clipboard.js';
import { blenderAgentBrief } from '../../../lib/musicVideoBlender.js';
import { formatCount } from '../../../utils/formatters.js';
import { buttonCls, primaryCls } from './blenderStyles.js';

/**
 * Where the film lives and how to start it: the workspace folder (copyable),
 * "Create starter workspace" while there is no `src/film.py`, and "Copy agent
 * brief": a ready-to-paste brief for a coding agent, built from the state on
 * screen (project id, workspace, the film contract, the routes, the skill).
 */
export default function BlenderWorkspace({ blender, lead = null }) {
  const { state, pending, projectId } = blender;
  const workspace = state.workspace || {};
  // Where this machine keeps the film: the folder an editor or a coding agent opens.
  const folder = workspace.path || workspace.dir || `data/music-video/${projectId}/blender`;
  return (
    <section aria-label="Film workspace" className="min-w-0 space-y-2">
      {lead}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="text-port-text-muted">Workspace</span>
        <code className="min-w-0 break-all font-mono">{folder}</code>
        <button type="button" className={buttonCls} onClick={() => copyToClipboard(folder, 'Workspace path copied')}>Copy path</button>
        <span className="text-port-text-muted">
          {workspace.hasFilm ? `${formatCount(workspace.files ?? 0)} source ${workspace.files === 1 ? 'file' : 'files'}` : 'No src/film.py yet'}
        </span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {!workspace.hasFilm && (
          <button type="button" className={primaryCls} disabled={!!pending.workspace} onClick={() => blender.createWorkspace()}>
            <FolderPlus size={14} aria-hidden="true" /> {pending.workspace ? 'Creating…' : 'Create starter workspace'}
          </button>
        )}
        <button type="button" className={buttonCls} onClick={() => copyToClipboard(blenderAgentBrief({ projectId, state, standalone: !!state.timeline }), 'Agent brief copied')}>
          <ClipboardCopy size={14} aria-hidden="true" /> Copy agent brief
        </button>
      </div>
    </section>
  );
}
