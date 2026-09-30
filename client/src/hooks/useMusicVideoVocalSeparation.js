import { useEffect, useRef } from 'react';
import useSseJobSlot from './useSseJobSlot.js';
import {
  separateMusicVideoVocals,
  musicVideoVocalSeparationEventsUrl,
  cancelMusicVideoVocalSeparation,
} from '../services/apiMusicVideo.js';

const STAGE_LABELS = {
  preparing: 'Preparing…',
  provision: 'Creating the demucs environment…',
  installing: 'Installing demucs (first run only)…',
  separating: 'Separating vocals…',
  attaching: 'Attaching the stem…',
};

/**
 * "Separate vocals" for a Music Video project: one demucs job over SSE whose
 * terminal frame carries the project with its new vocal stem. `start(projectId)`
 * is the button; `run(projectId)` is the same job as a promise for the
 * autopilot kickoff — it resolves with the updated project, or null when the
 * job failed, was cancelled or lost its stream (each already reported).
 * `onSeparated(projectId, project)` fires on success.
 */
export default function useMusicVideoVocalSeparation({ onSeparated } = {}) {
  const waiter = useRef(null);
  const settle = (value) => {
    const pending = waiter.current;
    waiter.current = null;
    pending?.resolve(value);
  };
  const slot = useSseJobSlot({
    startRequest: (projectId) => separateMusicVideoVocals(projectId, { silent: true }),
    eventsUrl: musicVideoVocalSeparationEventsUrl,
    cancelRequest: cancelMusicVideoVocalSeparation,
    onComplete: (frame, projectId) => {
      if (frame.project) onSeparated?.(projectId, frame.project);
      settle(frame.project || null);
    },
    successToast: () => 'Vocals separated and attached as the stem',
    errorFallback: 'Vocal separation failed',
    canceledMessage: 'Vocal separation cancelled',
    lostConnectionMessage: 'Lost connection to the vocal separation',
    startErrorFallback: 'Could not start vocal separation',
    onErrorFrame: () => { settle(null); return false; },
    onKickoffError: () => { settle(null); return false; },
  });

  // Cancel and a dropped stream clear the slot without a callback; release
  // the kickoff waiting on it.
  useEffect(() => {
    if (!slot.active && waiter.current?.started) settle(null);
    if (slot.active && waiter.current) waiter.current.started = true;
  }, [slot.active]);
  useEffect(() => () => settle(null), []);

  const run = (projectId) => new Promise((resolve) => {
    if (slot.active) { resolve(null); return; }
    waiter.current = { resolve, started: false };
    slot.start(projectId);
  });

  return {
    ...slot,
    stageLabel: STAGE_LABELS[slot.stage] || (slot.active ? 'Separating vocals…' : null),
    run,
  };
}
