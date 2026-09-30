import { useRef, useState } from 'react';
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
// A step reports its own failure; one that throws or rejects anyway counts as
// failed rather than stranding the run half way.
const attempt = (step, project) => Promise.resolve().then(() => step(project)).catch(() => null);
const allAligned = (project) => hasCues(project) && project.lyricCues.every((cue) => (cue.words || []).length > 0);
const castAndSetsDone = (project) => ['approved', 'skipped'].includes(project?.castAndSets?.status);

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
 * The check-in is a gate: `castAndSets` resolves once the stage reaches a
 * checkpoint, and the run plans only when that checkpoint is approved or
 * skipped. In review mode the stage stops at `review`, so the run ends there
 * ("Waiting for your check-in"); the director approves and runs the kickoff
 * again, which skips every finished step and plans. Auto mode approves itself
 * and the run continues straight to the plan. The step is optional so a caller
 * without it plans directly.
 *
 * Returns `{ step, stepLabel, running, run(project) }`; `step` names the
 * running step (a key of MUSIC_VIDEO_KICKOFF_STEPS).
 */
export default function useMusicVideoKickoff({ analyze, importLyrics, separateVocals, alignLyrics, castAndSets, plan }) {
  const [step, setStep] = useState(null);
  const busy = useRef(false);
  const mounted = useMounted();
  const enter = (id) => { if (mounted.current) setStep(id); };

  const run = async (start) => {
    if (!start || busy.current) return;
    busy.current = true;
    let project = start;
    try {
      if (!project.audioAnalysis) {
        enter('analyze');
        project = await attempt(analyze, project);
        if (!project?.audioAnalysis) return;
      }
      if (!hasCues(project) && project.trackId) {
        enter('lyrics');
        project = (await attempt(importLyrics, project)) || project;
      }
      if (hasCues(project) && !project.vocalStemFilename) {
        enter('vocals');
        project = (await attempt(separateVocals, project)) || project;
      }
      if (hasCues(project) && !allAligned(project)) {
        enter('align');
        project = (await attempt(alignLyrics, project)) || project;
      }
      if (castAndSets && !castAndSetsDone(project)) {
        enter('castAndSets');
        const checked = await attempt(castAndSets, project);
        // Waiting for the director (review), or the check-in failed: stop here.
        if (!castAndSetsDone(checked)) return;
        project = checked;
      }
      enter('plan');
      await attempt(plan, project);
    } finally {
      busy.current = false;
      enter(null);
    }
  };

  return { step, stepLabel: step ? MUSIC_VIDEO_KICKOFF_STEPS[step] : null, running: step !== null, run };
}
