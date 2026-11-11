import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import BlenderTimelineStrip from './BlenderTimelineStrip.jsx';
import BlenderBulkActions from './BlenderBulkActions.jsx';
import BlenderShotList from './BlenderShotList.jsx';
import BlenderShotDetail from './BlenderShotDetail.jsx';
import BlenderSyncControl from './BlenderSyncControl.jsx';
import BlenderReadiness from './BlenderReadiness.jsx';
import BlenderWorkspace from './BlenderWorkspace.jsx';
import { blenderSongDuration } from '../../../lib/musicVideoBlender.js';
import { formatCount } from '../../../utils/formatters.js';
import { buttonCls, noticeCls } from './blenderStyles.js';

export const BLENDER_SHOT_PARAM = 'bshot';

/**
 * The film shot by shot: the timeline across the song, the dense shot list
 * with bulk renders, and the selected shot's player, actions and note. The
 * selected shot is `?bshot=<shotId>`; a link to a shot the film no longer has
 * falls back to the first one and says so. Before there are shots it offers
 * the one next step: a starter workspace, a sync, or Blender setup.
 */
export default function BlenderShotsTab({ blender, project, audioUrl, onOpenPreview, onOpenTab }) {
  const { state } = blender;
  const [searchParams, setSearchParams] = useSearchParams();
  const shots = state.manifest?.shots || [];
  const requested = searchParams.get(BLENDER_SHOT_PARAM);
  const shot = shots.find((entry) => entry.id === requested) || shots[0] || null;
  const shotId = shot?.id || null;
  const [playhead, setPlayhead] = useState(null);
  const detailRef = useRef(null);
  const toolReady = !!state.tool?.ready && (!state.tool.executionMode || state.tool.executionMode === 'trusted-local');
  // Why a render cannot start: Blender setup, something unsaved, or a film that must be synced again.
  const blocker = blender.renderBlocker;
  const problems = state.manifest?.problems || [];

  useEffect(() => { setPlayhead(null); }, [shotId]);

  const select = useCallback((id) => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set(BLENDER_SHOT_PARAM, id);
      return next;
    }, { replace: true });
  }, [setSearchParams]);
  // Stacked (a phone), the detail sits under the list: bring it into view when a row picks a shot.
  const selectFromList = useCallback((id) => {
    select(id);
    const detail = detailRef.current;
    if (detail && detail.getBoundingClientRect().top > window.innerHeight * 0.6) detail.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }, [select]);

  if (!state.workspace?.hasFilm) {
    return (
      <BlenderWorkspace blender={blender} lead={(
        <p className="text-sm">
          No film scripts yet. A Blender film is Python that builds and animates every shot, starting at <code className="font-mono text-xs">src/film.py</code>.
          Create the starter workspace and edit it, or hand the brief to a coding agent.
        </p>
      )} />
    );
  }
  if (!shots.length) {
    return (
      <div className="min-w-0 space-y-2">
        <p className="text-sm">
          {state.manifest ? 'The last sync found no shots.' : 'The film scripts are in place, but their shots are not listed yet.'} Sync runs the
          film&apos;s <code className="font-mono text-xs">describe()</code> in Blender, lists its shots here and mirrors them to the storyboard.
        </p>
        <BlenderSyncControl blender={blender} />
        {!toolReady && <BlenderReadiness blender={blender} />}
      </div>
    );
  }

  return (
    <div className="@container min-w-0 space-y-2">
      {!toolReady && <BlenderReadiness blender={blender} />}
      {state.manifest.srcChanged && (
        <div className={noticeCls}>
          <BlenderSyncControl blender={blender} showProblems={false} />
        </div>
      )}
      {problems.length > 0 && (
        <p role="status" className={`${noticeCls} flex flex-wrap items-center gap-x-2`}>
          <span className="min-w-0 break-words">
            The last sync found {formatCount(problems.length)} {problems.length === 1 ? 'problem' : 'problems'}: {problems[0]}
            {problems.length > 1 ? ` (and ${formatCount(problems.length - 1)} more under Settings)` : ''}
          </span>
          <button type="button" className={buttonCls} onClick={() => onOpenTab('settings')}>Open Settings</button>
        </p>
      )}
      {requested && requested !== shotId && (
        <p role="status" className="text-xs text-port-warning">Shot {requested} is no longer in the film. Showing {shotId}.</p>
      )}
      <BlenderTimelineStrip
        state={state}
        sections={project.audioAnalysis?.sections || []}
        durationSec={blenderSongDuration(project, state)}
        selectedId={shotId}
        onSelect={select}
        playheadSec={playhead ?? shot.start}
      />
      <div className="grid min-w-0 grid-cols-1 items-start gap-3 @2xl:grid-cols-[minmax(15rem,21rem)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-2">
          <BlenderBulkActions blender={blender} blocked={!!blocker} />
          <BlenderShotList projectId={blender.projectId} state={state} selectedId={shotId} onSelect={selectFromList} noteDrafts={blender.noteDrafts} />
        </div>
        <div ref={detailRef} className="min-w-0 scroll-mt-[calc(var(--mv-header-h,9rem)+0.5rem)]">
          <BlenderShotDetail blender={blender} shot={shot} audioUrl={audioUrl} blocker={blocker} onTime={setPlayhead} onOpenPreview={onOpenPreview} onOpenTab={onOpenTab} />
        </div>
      </div>
    </div>
  );
}
