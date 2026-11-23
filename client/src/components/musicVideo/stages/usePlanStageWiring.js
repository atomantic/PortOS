import { useState } from 'react';
import toast from '../../ui/Toast';
import {
  importMusicVideoTrackLyrics,
  planMusicVideoProject,
  updateMusicVideoProject,
  updateMusicVideoScene,
} from '../../../services/apiMusicVideo.js';
import useMusicVideoKickoff from './useMusicVideoKickoff.js';
import useAutonomousMusicVideo from './useAutonomousMusicVideo.js';
import useDrawerTab from '../../../hooks/useDrawerTab.js';
import { aiSkipLabel } from '../../../hooks/useMusicVideoTreatment.js';
import { ownWrite } from '../../../services/socketWriteOrigin.js';
import { autoArrangeScenes } from '../../../lib/beatGrid.js';
import { AUTONOMOUS_VIEWABLE_STAGES } from '../../../lib/musicVideoAutonomous.js';

// Why the autopilot kickoff can't run yet, or null when it can.
function autopilotBlocker(project) {
  if (!project) return null;
  if (!project.trackId && !project.uploadedAudioFilename) return 'Attach a track before starting autopilot.';
  if ((project.scenes || []).length > 0) return 'The board already has shots — edit them below or fork a new version to re-plan.';
  return null;
}

/**
 * Storyboard step (Plan) and the autopilot that fills it: the shot planner,
 * auto-arrange, the kickoff chain that ends in a plan, the autonomous run and
 * the unsaved planning draft the storyboard approval edits.
 */
export default function usePlanStageWiring({
  selected, replaceProject, analyzing, onAnalyze, separation, lyricAlign, castSets, creativeSetupPending, styleReferencesPending,
  applyEdit, reloadOpenProject, saveOwnEdit,
}) {
  const [arranging, setArranging] = useState(false);
  const [planning, setPlanning] = useState(false);
  const autonomous = useAutonomousMusicVideo({ project: selected, replaceProject });
  // Which finished autonomous stage's output is open (`?run-stage=lyrics`).
  const [runStage, setRunStage] = useDrawerTab('run-stage', null, AUTONOMOUS_VIEWABLE_STAGES);
  // Unsaved planning edits live here, not in the approval section, so they survive a tab switch (each tab mounts its own section).
  const planningDraft = useState(null);

  // Autonomous shot planner (#1855, multi-shot #8964): tile each analyzed
  // section with bounded shots — cut on timed lyric lines, phrase edges and
  // the beat grid, capped at the renderer's clip length — and seed them onto
  // the board, optionally with a first-pass framePrompt/prompt per shot.
  // Director-first — seeded shots are ordinary, fully-editable board entries.
  // `target` lets the autopilot kickoff plan the freshly analyzed record
  // before `selected` re-renders with it.
  const handlePlan = (target = selected, mode) => {
    if (!target?.audioAnalysis) return Promise.resolve();
    setPlanning(true);
    return planMusicVideoProject(target.id, { seedPrompts: true, ...(mode ? { mode } : {}) }, { silent: true })
      .then(({ project, scenesAdded, promptsSeeded, promptsSkippedReason }) => {
        replaceProject(project);
        const suffix = promptsSeeded
          ? ' with first-pass prompts'
          : (promptsSkippedReason && promptsSkippedReason !== 'not-requested' ? ` (prompts skipped: ${aiSkipLabel(promptsSkippedReason)})` : '');
        toast.success(`Planned ${scenesAdded} shot${scenesAdded === 1 ? '' : 's'}${suffix}`);
      })
      .catch((err) => toast.error(err?.message || 'Plan failed'))
      .finally(() => setPlanning(false));
  };

  // Autopilot kickoff: analyze the song, import the track's lyric sheet,
  // separate the vocal, align the words, then plan every shot against the
  // brief (the planner reads automation.guidance). Each step only runs when
  // its result is missing; lyric/vocal/alignment failures still plan.
  const autopilotBlockedReason = (creativeSetupPending || styleReferencesPending)
    ? 'Save or cancel the creative setup before starting autopilot.'
    : autopilotBlocker(selected);
  const kickoff = useMusicVideoKickoff({
    analyze: () => onAnalyze(),
    // The kickoff carries its own copy of the project forward, so it takes the cues from the edit result too.
    importLyrics: (project) => saveOwnEdit(project.id, (options) => importMusicVideoTrackLyrics(project.id, { mode: 'if-empty' }, options))
      .then(({ edit, imported }) => {
        if (imported) toast.success(`Imported ${imported} lyric line${imported === 1 ? '' : 's'} from the track`);
        const changed = edit?.project;
        return changed ? { ...project, lyricCues: changed.lyricCues ?? project.lyricCues, lyricMarkers: changed.lyricMarkers ?? project.lyricMarkers, updatedAt: edit.updatedAt } : project;
      })
      .catch((err) => { toast.error(err?.message || 'Could not import the track lyrics'); return null; }),
    separateVocals: (project) => separation.run(project.id),
    alignLyrics: (project) => lyricAlign.run(project.id)
      .catch((err) => { toast.error(err?.message || 'Could not align the words — planning without word timings'); return null; }),
    castAndSets: (project) => castSets.runToCheckpoint(project),
    cancelCastAndSets: () => castSets.cancelWait(),
    plan: (project) => handlePlan(project),
  });
  // Approve & continue: the kickoff resumes past the check-in and plans —
  // unless a server production run owns this board (it continues on its own).
  const continueAfterCheckin = (res) => {
    const next = res?.project;
    if (!next || (next.scenes || []).length) return;
    if ((next.productionRuns || []).some((r) => r.status === 'running')) return;
    kickoff.run(next);
  };
  const approveCastAndSets = (basis) => castSets.approve(basis).then(continueAfterCheckin);
  const skipCastAndSets = () => castSets.skip().then(continueAfterCheckin);
  const handleKickoff = () => {
    if (!selected || analyzing || planning || kickoff.running || autopilotBlockedReason) return;
    kickoff.run(selected);
  };
  // Saving a brief hands the project to autopilot, so mode follows it.
  const saveAutomation = (automation) => saveOwnEdit(selected.id, (options) => updateMusicVideoProject(selected.id, { automation, mode: 'autonomous' }, options))
    .catch((err) => { toast.error(err?.message || 'Failed to save automation brief'); throw err; });

  // Auto-arrange (#1915): distribute every scene across the analyzed song
  // sections weighted by each section's energy, writing the same persisted
  // startSec/endSec/beatAligned fields the manual drag-snap arranger (#1854)
  // writes — a director-tunable starting point honored exactly at render time.
  // Optimistically applies the whole arrangement to the local board, then
  // persists each scene sequentially (the per-project load-modify-save can't
  // drop a write that way). Silent PATCHes — the catch owns the only error toast.
  // Each PATCH is this tab's own write and its edit result is patched in: one
  // change broadcast per shot used to reload the whole project per shot (#16210).
  // A failure part-way reloads once, so the board shows what was saved.
  const handleAutoArrange = () => {
    if (!selected?.audioAnalysis) return;
    const scenes = selected.scenes || [];
    const arrangement = autoArrangeScenes(scenes, selected.audioAnalysis);
    if (arrangement.length === 0) {
      toast.error('Nothing to arrange — analyze the track and add scenes first');
      return;
    }
    const byId = new Map(arrangement.map((a) => [a.sceneId, a]));
    // Snapshot the pre-arrangement project so a mid-loop PATCH failure can roll the
    // optimistic board back to match the server-side partial state — otherwise the
    // local board shows the complete arrangement over a partial persist until reload.
    const snapshot = selected;
    const projectId = selected.id;
    replaceProject({
      ...selected,
      scenes: scenes.map((s) => {
        const a = byId.get(s.sceneId);
        return a ? { ...s, startSec: a.startSec, endSec: a.endSec, beatAligned: a.beatAligned } : s;
      }),
    });
    setArranging(true);
    (async () => {
      for (const a of arrangement) {
        // Sequential by design — see the comment above (avoids a load-modify-save race).
        const { edit } = await updateMusicVideoScene(
          projectId, a.sceneId,
          { startSec: a.startSec, endSec: a.endSec, beatAligned: a.beatAligned },
          ownWrite(),
        );
        applyEdit(projectId, edit);
      }
    })()
      .then(() => toast.success(`Auto-arranged ${arrangement.length} scene${arrangement.length === 1 ? '' : 's'} by energy`))
      .catch((err) => {
        // Revert the optimistic board, then read what the server kept of the partial write.
        replaceProject(snapshot);
        void reloadOpenProject(projectId);
        toast.error(err?.message || 'Auto-arrange failed');
      })
      .finally(() => setArranging(false));
  };

  return {
    planning,
    arranging,
    kickoff,
    autonomous,
    autopilotBlockedReason,
    planningDraft,
    handlePlan,
    handleKickoff,
    approveCastAndSets,
    board: {
      autonomous,
      runStage,
      onSelectStage: setRunStage,
      kickoff,
      autopilotBlockedReason,
      saveAutomation,
      onPlan: (mode) => handlePlan(selected, mode),
      onAutoArrange: handleAutoArrange,
      onKickoff: handleKickoff,
      approveCastAndSets,
      skipCastAndSets,
      planningDraft,
    },
  };
}
