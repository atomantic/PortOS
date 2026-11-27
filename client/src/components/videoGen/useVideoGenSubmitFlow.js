/**
 * Builds the current VideoGen wire payload and enveloped prompt from a form-state snapshot.
 *
 * Use when: Internal submission slice composed by `useVideoGenForm`; all local, hosted, and federated
 * request shaping remains in `buildVideoGenPayload`.
 */

import { useCallback, useRef } from 'react';
import { buildVideoGenPayload, envelopVideoPrompt } from '../../lib/buildVideoGenPayload.js';

/** Keeps request shaping behind one focused boundary for every VideoGen lane. */
export function useVideoGenSubmitFlow(submissionState) {
  const submissionStateRef = useRef(submissionState);
  submissionStateRef.current = submissionState;

  const buildGeneratePayload = useCallback(
    () => buildVideoGenPayload(submissionStateRef.current),
    [],
  );

  return {
    buildGeneratePayload,
    envelopedPrompt: envelopVideoPrompt(submissionState.prompt, submissionState),
  };
}

export default useVideoGenSubmitFlow;
