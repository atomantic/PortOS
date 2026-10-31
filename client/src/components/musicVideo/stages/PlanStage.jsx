import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { CheckCircle2, ListMusic, Loader2, RotateCcw } from 'lucide-react';
import InlineConfirmRow from '../../ui/InlineConfirmRow';
import toast from '../../ui/Toast';
import { getMusicVideoProject, groupStoryboardBySong } from '../../../services/api';
import { storyboardFitSong } from '../../../../../server/lib/storyboardFit.js';
import StageSection from '../StageSection.jsx';
import StoryboardLinkPanel, { useStoryboardLink } from '../StoryboardLinkPanel.jsx';
import StoryboardFitPanel from '../StoryboardFitPanel.jsx';
import StoryboardSyncPanel from '../StoryboardSyncPanel.jsx';
import StoryboardEditor from '../../storyboards/StoryboardEditor';

/**
 * Storyboard: the video's linked Create › Storyboards board, edited in place
 * (beats, panels, sketch frames, the animatic played with the song), with its open panel in the URL
 * at `/music-video/:projectId/board/panel/:panelId`. With no board linked yet
 * the step offers to start one. Each panel shows its time on the song and the
 * line sung over it. Below the board, Make shots syncs one shot per panel at
 * the panel's own time and keeps them in sync after each board edit
 * (StoryboardSyncPanel), or fits the panels to the song in proportion (Fit to
 * song); the shots are finished on Shots (transitions, effects, takes).
 *
 * The editor's toolbar also carries this step's own actions: Group by song
 * sections (one beat per section of the analyzed song, panels kept), and
 * Reopen storyboard / Approve storyboard, which mark the step not done while
 * the panels are reworked (`storyboardReopenedAt`).
 */
export default function PlanStage({ board }) {
  const { project, locked, busy } = board;
  const { panelId } = useParams();
  const scenes = project.scenes || [];
  const linkedId = project.storyboardId || null;
  const [storyboard, setStoryboard] = useState(null);
  const [staleReads, setStaleReads] = useState(0);
  const { linkStoryboard, linkError } = useStoryboardLink(board);
  const shownBoard = storyboard?.id === linkedId ? storyboard : null;
  const [confirmGroup, setConfirmGroup] = useState(false);
  const [grouping, setGrouping] = useState(false);
  const sections = project.audioAnalysis?.sections || [];
  const reopened = !!project.storyboardReopenedAt;
  const timingSong = useMemo(() => storyboardFitSong(project), [project]);
  // A board edit syncs the shots on the server before it answers: read them again.
  const syncOn = project.storyboardSync === true;
  const boardSeen = useRef(null);
  useEffect(() => {
    if (!shownBoard) return;
    const seen = boardSeen.current;
    boardSeen.current = shownBoard.updatedAt;
    if (!syncOn || !seen || seen === shownBoard.updatedAt) return;
    getMusicVideoProject(project.id, { silent: true }).then((next) => { if (next?.id === project.id) board.replaceProject(next); }).catch(() => {});
  }, [shownBoard?.updatedAt, syncOn, project.id]); // `board` is a fresh object each render
  // Play on the board plays this video's own song, with its timed lines.
  const lyricCues = project.lyricCues;
  const song = useMemo(() => (board.audioUrl ? {
    src: board.audioUrl,
    name: project.name || 'The song',
    lines: (lyricCues || []).filter((cue) => Number.isFinite(cue?.startSec) && cue.text).map((cue) => ({ id: cue.id, text: cue.text, at: cue.startSec })),
  } : null), [board.audioUrl, project.name, lyricCues]);
  const setReopened = (on) => {
    const storyboardReopenedAt = on ? new Date().toISOString() : null;
    board.editProjectLocal({ storyboardReopenedAt });
    return board.saveProjectFields({ storyboardReopenedAt });
  };
  const groupBySong = async () => {
    setConfirmGroup(false);
    setGrouping(true);
    const grouped = await groupStoryboardBySong(project.id).catch(() => null);
    setGrouping(false);
    if (!grouped) return;
    setStaleReads((n) => n + 1);
    toast.success(`Grouped into ${grouped.beats.length} song section${grouped.beats.length === 1 ? '' : 's'}`);
  };
  const toolbarButton = 'min-h-[44px] inline-flex items-center gap-1.5 rounded border border-port-border px-3 text-sm text-gray-200 hover:border-port-accent/60 hover:text-white disabled:opacity-40';
  const storyboardActions = (
    <>
      {reopened ? (
        <button type="button" id="mv-board-approve" onClick={() => setReopened(false)} disabled={locked}
          className="min-h-[44px] inline-flex items-center gap-1.5 rounded bg-port-accent px-3 text-sm text-white hover:bg-port-accent/80 disabled:opacity-40">
          <CheckCircle2 size={16} aria-hidden="true" /> Approve storyboard
        </button>
      ) : scenes.length > 0 ? (
        <button type="button" onClick={() => setReopened(true)} disabled={locked} className={toolbarButton}>
          <RotateCcw size={16} aria-hidden="true" /> Reopen storyboard
        </button>
      ) : null}
      {sections.length > 0 && (
        <button type="button" onClick={() => setConfirmGroup(true)} disabled={locked || grouping} className={toolbarButton}>
          {grouping ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <ListMusic size={16} aria-hidden="true" />} Group by song sections
        </button>
      )}
      {confirmGroup && (
        <InlineConfirmRow autoFocus aria-label="Group by song sections" className="basis-full" tone="warning" confirmText="Group"
          question="Regroup the beats by the song's sections (intro, verse, chorus…)? Panels stay in order; beat titles become the section names."
          onConfirm={groupBySong} onCancel={() => setConfirmGroup(false)} />
      )}
    </>
  );
  return (
    <div className="min-w-0 space-y-3">
      {linkedId ? (
        <section id="mv-board-storyboard" aria-label="Storyboard" className="min-w-0">
          <StoryboardEditor key={linkedId} embedded boardId={linkedId} panelId={panelId}
            boardPath={`/music-video/${encodeURIComponent(project.id)}/board`} onBoard={setStoryboard} refreshKey={staleReads}
            actions={storyboardActions} song={song} timingSong={timingSong} />
        </section>
      ) : (
        <StageSection id="mv-board-storyboard" title="Start the storyboard" defaultOpen
          summary="Beats and sketched panels for the story">
          <StoryboardLinkPanel project={project} onLink={linkStoryboard} />
          {linkError && <p role="alert" className="text-xs text-port-error">{linkError}</p>}
        </StageSection>
      )}

      {shownBoard && shownBoard.beats.some((beat) => beat.panels.length) && (
        <StageSection id="mv-board-fit" title="Make shots" defaultOpen={scenes.length === 0}
          summary={syncOn ? `${scenes.length} shot${scenes.length === 1 ? '' : 's'} on Shots, kept in sync with the panels`
            : scenes.length ? `${scenes.length} shot${scenes.length === 1 ? '' : 's'} on Shots; sync them to the panels` : 'One shot per panel, at its time on the song'}>
          <StoryboardSyncPanel project={project} board={shownBoard} disabled={locked || busy.planning || busy.arranging}
            onSynced={(saved) => board.replaceProject(saved)} onBoardStale={() => setStaleReads((n) => n + 1)} />
          {!syncOn && (
            <details className="mt-2">
              <summary className="min-h-[44px] flex items-center cursor-pointer text-xs text-gray-400">Or fit the panels to the song in proportion</summary>
              <StoryboardFitPanel project={project} board={shownBoard} disabled={locked || busy.planning || busy.arranging}
            onFitted={(saved) => board.editProjectLocal(saved)} onBoardStale={() => setStaleReads((n) => n + 1)} />
            </details>
          )}
        </StageSection>
      )}
    </div>
  );
}
