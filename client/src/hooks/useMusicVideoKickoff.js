import { useRef, useState } from 'react';
import toast from '../components/ui/Toast';
import useMounted from './useMounted.js';

export const MUSIC_VIDEO_KICKOFF_STEPS = Object.freeze({
  analyze: 'Analyzing the song…',
  lyrics: 'Importing track lyrics…',
  vocals: 'Separating vocals…',
  align: 'Aligning words…',
  castAndSets: 'Building the Cast & Sets check-in…',
  plan: 'Planning shots…',
});

const hasCues = (project) => (project?.lyricCues || []).length > 0;
const stepName = (id) => MUSIC_VIDEO_KICKOFF_STEPS[id].replace(/…$/, '');
// A step reports its own failure; one that throws or rejects anyway counts as
// failed rather than stranding the run half way — and says so, so the run never
// ends without a word (#9940).
const attempt = (id, step, project) => Promise.resolve().then(() => step(project)).catch((err) => {
  console.error(`❌ Music Video kickoff step "${id}" threw: ${err?.message || 'unknown error'}`);
  toast.error(`Kickoff: ${stepName(id)} failed — ${err?.message || 'unexpected error'}`);
  return null;
});
const allAligned = (project) => hasCues(project) && project.lyricCues.every((cue) => (cue.words || []).length > 0);
const castAndSetsDone = (project) => ['approved', 'skipped'].includes(project?.castAndSets?.status);
const castAndSetsStopped = (project) => !!project?.castAndSets && (project.castAndSets.interrupted || project.castAndSets.status === 'failed');

/**
 * The Music Video autopilot kickoff ("Analyze & plan"): analyze → import the
 * track's lyrics → separate vocals → align words → Cast & Sets check-in →
 * plan. Each step is skipped when its result already exists (a beat map,
 * lyric lines, a vocal stem, aligned words, an approved or skipped check-in),
 * so a re-run only does what is missing. Every step receives the freshest
 * project and resolves with the updated one, or null when it failed (the step
 * reports its own error). A failed analysis stops the run — nothing can be
 * planned without sections — while a failed lyric, vocal or alignment step
 * leaves the plan to work with what exists.
 *
 * The check-in runs for every project, code-first ones included (the server
 * picks its medium from the production policy and tools). It is a gate: `castAndSets` resolves once the stage reaches a
 * checkpoint, and the run plans only when that checkpoint is approved or
 * skipped. In review mode the stage stops at `review`, so the run ends there
 * ("Waiting for your check-in"); the director approves and runs the kickoff
 * again, which skips every finished step and plans. Auto mode approves itself
 * and the run continues straight to the plan. A stage that failed or was
 * interrupted by a restart also ends the run — with a note saying why, since
 * the director must resume it. The step is optional so a caller without it
 * plans directly.
 *
 * `cancel()` ends the run (#9940): it abandons a Cast & Sets wait at once
 * (`cancelCastAndSets` — the server keeps working on the stage) and stops
 * before the next step otherwise. A request already in flight finishes.
 *
 * Returns `{ step, stepLabel, running, run(project), cancel() }`; `step` names
 * the running step (a key of MUSIC_VIDEO_KICKOFF_STEPS).
 */
export default function useMusicVideoKickoff({ analyze, importLyrics, separateVocals, alignLyrics, castAndSets, cancelCastAndSets, plan }) {
  const [step, setStep] = useState(null);
  const busy = useRef(false);
  const cancelled = useRef(false);
  const mounted = useMounted();
  const enter = (id) => { if (mounted.current) setStep(id); };

  const run = async (start) => {
    if (!start || busy.current) return;
    busy.current = true;
    cancelled.current = false;
    let project = start;
    try {
      if (!project.audioAnalysis) {
        enter('analyze');
        project = await attempt('analyze', analyze, project);
        if (!project?.audioAnalysis || cancelled.current) return;
      }
      if (!hasCues(project) && project.trackId) {
        enter('lyrics');
        project = (await attempt('lyrics', importLyrics, project)) || project;
        if (cancelled.current) return;
      }
      if (hasCues(project) && !project.vocalStemFilename) {
        enter('vocals');
        project = (await attempt('vocals', separateVocals, project)) || project;
        if (cancelled.current) return;
      }
      if (hasCues(project) && !allAligned(project)) {
        enter('align');
        project = (await attempt('align', alignLyrics, project)) || project;
        if (cancelled.current) return;
      }
      // Code-first projects keep the check-in: the server directs it in the
      // procedural medium (how the characters are built and move, how the
      // world behaves), not as a photographic cast.
      if (castAndSets && !castAndSetsDone(project)) {
        enter('castAndSets');
        const checked = await attempt('castAndSets', castAndSets, project);
        if (cancelled.current) return;
        // Waiting for the director (review), or the check-in failed or was
        // interrupted: stop here, and say why when the director has to act.
        if (!castAndSetsDone(checked)) {
          if (castAndSetsStopped(checked)) {
            toast.info(`Kickoff paused: the Cast & Sets check-in ${checked.castAndSets.interrupted ? 'was interrupted by a restart' : 'failed'} — resume it, then run the kickoff again.`);
          }
          return;
        }
        project = checked;
      }
      enter('plan');
      await attempt('plan', plan, project);
    } finally {
      busy.current = false;
      enter(null);
    }
  };

  const cancel = () => {
    if (!busy.current || cancelled.current) return;
    cancelled.current = true;
    cancelCastAndSets?.();
    toast.info('Kickoff stopped — work the server already started keeps running.');
  };

  return { step, stepLabel: step ? MUSIC_VIDEO_KICKOFF_STEPS[step] : null, running: step !== null, run, cancel };
}
