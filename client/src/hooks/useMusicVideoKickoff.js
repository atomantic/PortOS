import { useRef, useState } from 'react';
import useMounted from './useMounted.js';

export const MUSIC_VIDEO_KICKOFF_STEPS = Object.freeze({
  analyze: 'Analyzing the song…',
  lyrics: 'Importing track lyrics…',
  vocals: 'Separating vocals…',
  align: 'Aligning words…',
  plan: 'Planning shots…',
});

const hasCues = (project) => (project?.lyricCues || []).length > 0;
// A step reports its own failure; one that throws or rejects anyway counts as
// failed rather than stranding the run half way.
const attempt = (step, project) => Promise.resolve().then(() => step(project)).catch(() => null);
const allAligned = (project) => hasCues(project) && project.lyricCues.every((cue) => (cue.words || []).length > 0);

/**
 * The Music Video autopilot kickoff ("Analyze & plan"): analyze → import the
 * track's lyrics → separate vocals → align words → plan. Each step is skipped
 * when its result already exists (a beat map, lyric lines, a vocal stem,
 * aligned words), so a re-run only does what is missing. Every step receives
 * the freshest project and resolves with the updated one, or null when it
 * failed (the step reports its own error). A failed analysis stops the run —
 * nothing can be planned without sections — while a failed lyric, vocal or
 * alignment step leaves the plan to work with what exists.
 *
 * Returns `{ step, stepLabel, running, run(project) }`; `step` names the
 * running step (a key of MUSIC_VIDEO_KICKOFF_STEPS).
 */
export default function useMusicVideoKickoff({ analyze, importLyrics, separateVocals, alignLyrics, plan }) {
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
      enter('plan');
      await attempt(plan, project);
    } finally {
      busy.current = false;
      enter(null);
    }
  };

  return { step, stepLabel: step ? MUSIC_VIDEO_KICKOFF_STEPS[step] : null, running: step !== null, run };
}
