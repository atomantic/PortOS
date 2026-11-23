/**
 * Builds the current VideoGen wire payload and enveloped prompt from a form-state snapshot.
 *
 * Use when: Internal submission slice composed by `useVideoGenForm`; all local, Grok, and federated
 * request shaping remains in `videoGenSubmission`.
 */

import { useCallback, useRef } from 'react';
import { buildVideoGenSubmission, envelopVideoPrompt } from '../../lib/videoGenSubmission.js';

/** Keeps request shaping behind one focused boundary for every VideoGen lane. */
export function useVideoGenSubmitFlow(submissionState) {
  const submissionStateRef = useRef(submissionState);
  submissionStateRef.current = submissionState;

  const buildGeneratePayload = useCallback(
    () => buildVideoGenSubmission(submissionStateRef.current),
    [],
  );

  return {
    buildGeneratePayload,
    envelopedPrompt: envelopVideoPrompt(submissionState.prompt, submissionState),
  };
}

export default useVideoGenSubmitFlow;
