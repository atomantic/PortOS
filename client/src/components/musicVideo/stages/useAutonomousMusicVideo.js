/**
 * Hook for the fully autonomous music-video run: applies pushed project updates, toasts
 * director-needed outcomes, and returns `{ busy, resume, ... }`.
 *
 * Fully-autonomous run (prompt → lyrics → Suno song → video): applies the project pushed on
 * `music-video:autonomous` and toasts the outcomes that need the director (checkpoint waiting, needs
 * you, finished, failed). Returns `{ busy, resume(edits?, { inline }?), stop(), cancel() }` (an
 * `inline` resume rejects instead of toasting, for errors shown next to the control). Use when: The
 * Music Video autonomous run panel.
 */

import toast from '../../ui/Toast';
import useMusicVideoRun from './useMusicVideoRun.js';
import {
  cancelAutonomousMusicVideo,
  resumeAutonomousMusicVideo,
  stopAutonomousMusicVideo,
} from '../../../services/apiMusicVideo.js';

const OUTCOME_TOASTS = {
  'awaiting-approval': (run) => toast.info(`Autonomous music video is waiting for your approval of the ${run.awaiting || 'last'} step`),
  'needs-human': (run) => toast.info(`Autonomous music video needs you: ${run.error || 'check the run'}`),
  completed: () => toast.success('Autonomous music video finished — review it'),
  failed: (run) => toast.error(`Autonomous music video failed: ${run.error || 'unknown error'}`),
};

/**
 * Fully-autonomous run (prompt → lyrics → Suno song → video). Starting one is
 * the Music Video page's create flow; this hook owns what happens afterwards:
 * it applies the project the server pushes over `music-video:autonomous` (no
 * polling) and toasts the outcomes that need the director.
 *
 * Returns `{ busy, resume(edits?, { inline }?), stop(), cancel() }`; an `inline` resume rejects instead of toasting.
 */
export default function useAutonomousMusicVideo({ project, replaceProject } = {}) {
  const projectId = project?.id || null;
  const { busy, call } = useMusicVideoRun({
    projectId,
    event: 'music-video:autonomous',
    toasts: OUTCOME_TOASTS,
    errorLabel: 'Autonomous run request failed',
    replaceProject,
  });

  const resume = (edits = {}, options = {}) => call(() => resumeAutonomousMusicVideo(projectId, edits, { silent: true }), options);
  const stop = () => call(() => stopAutonomousMusicVideo(projectId, { silent: true }));
  const cancel = () => call(() => cancelAutonomousMusicVideo(projectId, { silent: true }));

  return { busy, resume, stop, cancel };
}
