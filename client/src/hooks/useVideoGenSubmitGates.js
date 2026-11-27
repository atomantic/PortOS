/**
 * Everything that decides whether VideoGen can Generate or queue right now: prompt caps, peer-input refusals and the enqueue policy.
 *
 * Use when: The /media/video page renders the Generate / "Add to queue" buttons, their titles,
 * the Options caption and the prompt counter. One reading feeds every surface, so the button
 * and the guard behind it can never disagree.
 */

import { useMemo } from 'react';
import { REACTOR_MAX_PROMPT_LENGTH } from '../lib/reactorVideoClip.js';
import { videoGenEnqueuePolicy } from '../lib/videoGenEnqueuePolicy.js';
import { styledVideoPrompt } from '../lib/buildVideoGenPayload.js';
import { peerModelRequiresInput } from '../lib/federatedMediaReadiness.js';

/**
 * `form` is `useVideoGenForm()`; the rest is the page's fetched context
 * (`remoteTarget`, the BYOV probe, the weight assets, the model-context request).
 */
export function useVideoGenSubmitGates({
  form, remoteTarget, rendersOffMachine, rendersOnThisMachine, remixHandoffPending, notConnected, interpreterPending,
  byov, blockedAsset, modelContext, modelContextRequest, runwayCatalog,
}) {
  const { lane, prompt: promptFields, model, sampler, frames, keyframes, extend, audio, ic, runway, higgsfield } = form;
  const { mode, hostedLane, isGrok, isFal, isReactor, isRunway, isGemini, isHiggsfield, isGoogle } = lane;
  const { prompt, negativePrompt, stylePreset, selectedUniverse } = promptFields;
  const { currentModel, selectedLoras } = model;
  const { sourceImageFile, sourceImageUpload, lastImageFile, lastImageUpload } = frames;
  const { runwayModel, runwaySpecial, runwayPerformance, runwayInputs } = runway;
  const { higgsfieldModel } = higgsfield;

  // Conditioning the selected peer model cannot take. The server refuses a job
  // holding any of it (MEDIA_PROVIDER_INPUT_UNSUPPORTED) rather than silently
  // rendering something else, so the form says so before the user commits.
  // Nothing is cleared on picking a peer: the inputs stay filled and intact
  // for a switch back to This instance.
  //
  // Start and end FRAMES now cross when the model advertises the role (ADR
  // docs/decisions/2026-08-22-federated-media-input-assets.md rule 1) — but only
  // as a GALLERY pick. An UPLOAD is still staged in the multipart temp dir when
  // the federated branch runs, so it is not a path the uploader can read; the
  // remedy is to save it to the gallery first, which is what the message says.
  //
  // The rest stay refused, each for a recorded reason: LoRA weights are a MODEL
  // (rule 3), and keyframes / a clip to extend / IC-LoRA references / chained
  // chunks are multi-step CHAIN STATE this machine sequences (rule 4).
  const { keyframesActive } = keyframes;
  const { extendFromVideoId } = extend;
  const { audioFile } = audio;
  const { icReferenceFile, icReferenceVideoId, icReferenceImageFiles } = ic;
  const { chunks } = sampler;
  const remoteUnsupportedInputs = useMemo(() => {
    if (!remoteTarget.isRemote) return null;
    const targetModel = remoteTarget.model;
    const present = [
      ['the Grok backend', isGrok],
      ['the fal.ai backend', isFal],
      ['the reactor.inc backend', isReactor],
      ['the Runway backend', isRunway],
      ['the Gemini backend', isGemini],
      ['the Higgsfield backend', isHiggsfield],
      ['the Google backend', isGoogle],
      // Each remaining pipeline semantic has its own input listed below, but the
      // mode can be set before that input is filled — so gate the mode too
      // rather than letting an a2v render reach the peer as plain text-to-video.
      [`${mode} mode`, ![undefined, 'text', 'image', 'fflf'].includes(mode)],
      ['a source image', !!sourceImageFile && !remoteTarget.acceptsInput('sourceImage')],
      ['an end frame', !!lastImageFile && !remoteTarget.acceptsInput('lastImage')],
      ['an uploaded frame (save it to the gallery first)', !!sourceImageUpload || !!lastImageUpload],
      ['keyframes', keyframesActive],
      ['a source clip to extend', !!extendFromVideoId],
      ['an audio track', !!audioFile],
      ['IC-LoRA references', !!icReferenceFile || !!icReferenceVideoId || icReferenceImageFiles.length > 0],
      ['LoRA weights', selectedLoras.length > 0],
      ['chained chunks', chunks > 1],
    ].filter(([, set]) => set).map(([label]) => label);
    if (present.length) {
      return `The selected peer model cannot take ${present.join(', ')} — clear it to render on this peer.`;
    }
    // An end frame alone would render a plain text-to-video clip with the frame
    // silently discarded — a valid-looking render of a different thing.
    if (lastImageFile && !sourceImageFile) {
      return 'A federated first-last-frame render needs both ends — add a start frame, or render on this instance.';
    }
    if (peerModelRequiresInput(targetModel) && !sourceImageFile) {
      return `${targetModel?.modelName || 'The selected peer model'} renders only from a source image — add a start frame, or pick a text-to-video model.`;
    }
    return null;
  }, [remoteTarget.isRemote, remoteTarget.model, remoteTarget.acceptsInput, isGrok, isFal, isReactor, isRunway, isGemini, isHiggsfield, isGoogle, mode, sourceImageFile, sourceImageUpload,
    lastImageFile, lastImageUpload, keyframesActive, extendFromVideoId, audioFile, icReferenceFile,
    icReferenceVideoId, icReferenceImageFiles, selectedLoras, chunks]);
  // One reading for the Generate button, the enqueue guard and the caption.
  const remoteBlocked = remoteTarget.isRemote
    ? (remoteTarget.blockedReason || remoteUnsupportedInputs)
    : null;

  // reactor.inc rejects a prompt over 800 characters outright, and the limit
  // applies to what PortOS SUBMITS — style presets prefix the user's text, so
  // the counter measures the same string buildVideoGenPayload builds rather
  // than the textarea. Gating Generate on it turns a post-click 400 into a
  // number the user can watch while writing.
  // Runway caps the prompt per model; the server refuses an over-cap prompt
  // with its count rather than shortening it.
  const promptCap = isReactor ? REACTOR_MAX_PROMPT_LENGTH : isRunway ? runwayModel?.promptMaxChars ?? null : isHiggsfield ? higgsfieldModel.promptMax : null;
  const promptCapLabel = isReactor ? 'Reactor' : isHiggsfield ? higgsfieldModel.label : 'Runway';
  const submittedPromptLength = useMemo(
    () => (promptCap != null
      ? styledVideoPrompt(prompt, { negativePrompt, stylePreset, selectedUniverse }).length
      : prompt.length),
    [promptCap, prompt, negativePrompt, stylePreset, selectedUniverse],
  );
  const promptOverLimit = !runwayPerformance && promptCap != null && submittedPromptLength > promptCap;

  // Budget the AI enhancer writes inside. It's the backend cap MINUS the style
  // preset / universe prefix, because that prefix is part of what PortOS
  // submits — enhancing to exactly 800 characters would still be rejected once
  // the preset is prepended. `undefined` for a backend with no cap (and for the
  // degenerate case where the prefix alone already fills the allowance, which
  // the counter above is already flagging).
  const enhancePromptBudget = useMemo(() => {
    if (promptCap == null) return undefined;
    const overhead = submittedPromptLength - prompt.length;
    const budget = promptCap - Math.max(0, overhead);
    return budget > 0 ? budget : undefined;
  }, [promptCap, submittedPromptLength, prompt]);

  // Only grok folds a negative prompt into its request (as an "Avoid:" line);
  // fal's queue body, reactor's enqueue command and Gemini's composer have no such field, and a
  // CFG-distilled local model ignores one. Hide the box rather than showing a
  // dead field that quietly does nothing. A federated render is the PEER's
  // model to judge, so the local selection's gate must not take away a field
  // that lane does submit.
  const negativePromptSupported = isGrok || isRunway || isHiggsfield || isGoogle || remoteTarget.isRemote
    || (!isFal && !isReactor && !isGemini && currentModel?.supportsNegativePrompt !== false);

  // A federated render answers to the PEER’s readiness, not to this machine’s
  // runtime gates — none of the local probes below describe the hardware it
  // will actually run on.
  const effectiveBatchSize = rendersOnThisMachine
    && currentModel?.supportsWarmBatch && !sampler.chainingActive ? sampler.batchSize : 1;

  const { canEnqueue: backendCanEnqueue, generateTitle, queueTitle, optionsHint } = videoGenEnqueuePolicy({
    prompt,
    promptOptional: runwaySpecial,
    remixHandoffPending,
    promptOverLimit,
    isRemote: remoteTarget.isRemote,
    remoteBlocked,
    rendersOffMachine,
    notConnected,
    interpreterPending,
    byovRuntime: byov.byovRuntime,
    byovLabel: byov.byovStatus?.label,
    byovGateBlocked: byov.byovGateBlocked,
    byovRuntimeMissing: byov.byovRuntimeMissing,
    modelContextUnavailable: !modelContext && {
      loading: 'Loading the model list…',
      error: 'Retry the model list before generating or queueing',
    }[modelContextRequest.state],
    blockedAsset,
    extendModeBlocked: extend.extendModeBlocked,
    a2vModeBlocked: audio.a2vModeBlocked,
    a2vDurationError: audio.a2vDurationError,
    modelRuntime: currentModel?.runtime,
    audioFile,
    icLoraModeBlocked: ic.icLoraModeBlocked,
    keyframesBlocked: keyframes.keyframesBlocked,
    keyframesError: keyframes.keyframesError,
  });
  const specialInputsReady = !runwaySpecial || (!!runwayInputs.video && (!runwayPerformance || !!(runwayInputs.characterVideo || sourceImageFile || sourceImageUpload)));
  const canEnqueue = backendCanEnqueue && specialInputsReady && (!isRunway || runwayCatalog.videoModels.some((m) => m.id === runwayModel?.id));

  return {
    remoteUnsupportedInputs, remoteBlocked,
    promptCap, promptCapLabel, submittedPromptLength, promptOverLimit, enhancePromptBudget,
    negativePromptSupported, showNegativePromptHint: !negativePromptSupported && !hostedLane,
    effectiveBatchSize, canEnqueue, generateTitle, queueTitle, optionsHint,
  };
}

export default useVideoGenSubmitGates;
