/**
 * VideoGen render-lane state: the Local/hosted backend switch, each hosted provider's fields, and their per-model resets.
 *
 * Use when: Internal slice composed by `useVideoGenForm`. Each hosted provider (Grok, fal.ai,
 * reactor.inc, Runway, Gemini, Higgsfield, Google Veo) returns its own named group, so a new
 * provider adds a group here rather than more fields on the form's return.
 */

import { useEffect, useRef, useState } from 'react';
import { GROK_VIDEO_DEFAULT_DURATION } from '../../lib/grokVideoClip.js';
import { REACTOR_DEFAULT_CLIP_LENGTH } from '../../lib/reactorVideoClip.js';
import { falVideoResolutions, getFalVideoModel } from '../../lib/falVideoModels.js';
import {
  RUNWAY_DEFAULT_IMAGE_VIDEO_MODEL, getRunwayVideoModel, runwayModelTakesText, runwayVideoResolutions,
} from '../../lib/runwayVideoModels.js';
import { HIGGSFIELD_DEFAULT_VIDEO_MODEL, getHiggsfieldVideoModel } from '../../lib/higgsfieldVideoModels.js';
import { GOOGLE_DEFAULT_VIDEO_MODEL, getGoogleVideoModel } from '../../lib/googleVideoModels.js';
import { RUNWAY_SPECIAL_VIDEO_MODES, getRunwaySpecialVideoModel } from '../../../../server/lib/runwaySpecialVideoModels.js';

// The queue discriminator a hosted job is restored under, and the semantic
// video mode it rendered in (only text and image-to-video exist there).
const imageOrText = (p) => (p.videoMode === 'image' ? 'image' : 'text');

/**
 * `enabled` maps each hosted lane id to whether it is usable on this install.
 * Each lane stays gated on its own flag, so a persisted backend that is no
 * longer configured resolves to the local lane (`hostedLane === null`).
 */
export function useVideoGenBackendCaps({ enabled, mode }) {
  const [backend, setBackend] = useState('local');
  const [grokDuration, setGrokDuration] = useState(GROK_VIDEO_DEFAULT_DURATION);
  const [falDuration, setFalDuration] = useState('');
  const [falModelId, setFalModelId] = useState('');
  const [falResolution, setFalResolution] = useState('');
  const [falGenerateAudio, setFalGenerateAudio] = useState(false);
  // Runway: '' = the catalog default model / the model's default length and size.
  const [runwayModelId, setRunwayModelId] = useState('');
  const [runwayDuration, setRunwayDuration] = useState('');
  const [runwayResolution, setRunwayResolution] = useState('');
  const [runwayInputs, setRunwayInputs] = useState({});
  // Higgsfield: '' = the catalog default family / the family's default length and tier.
  const [higgsfieldModelId, setHiggsfieldModelId] = useState('');
  const [higgsfieldDuration, setHiggsfieldDuration] = useState('');
  const [higgsfieldResolution, setHiggsfieldResolution] = useState('');
  const [higgsfieldGenerateAudio, setHiggsfieldGenerateAudio] = useState(false);
  // Google Veo: '' = the catalog default model / the model's default length and tier.
  const [googleModelId, setGoogleModelId] = useState('');
  const [googleDuration, setGoogleDuration] = useState('');
  const [googleResolution, setGoogleResolution] = useState('');
  const [googleGenerateAudio, setGoogleGenerateAudio] = useState(false);
  const [reactorClipId, setReactorClipId] = useState('');
  const [reactorSeconds, setReactorSeconds] = useState(REACTOR_DEFAULT_CLIP_LENGTH);
  const [reactorSeed, setReactorSeed] = useState('');
  // '' is the picker's Auto entry: submit no aspect and let the server derive
  // the fast-h3 canvas from the starting frame (text renders fall back to 16:9).
  const [reactorAspect, setReactorAspect] = useState('');

  // Each fal model has its own resolution and audio capabilities.
  const falModelPickRef = useRef(falModelId);
  useEffect(() => {
    if (falModelPickRef.current === falModelId) return;
    falModelPickRef.current = falModelId;
    setFalResolution('');
    setFalGenerateAudio(false);
  }, [falModelId]);

  // Each Runway model has its own lengths and sizes.
  const runwayModelPickRef = useRef(runwayModelId);
  useEffect(() => {
    if (runwayModelPickRef.current === runwayModelId) return;
    runwayModelPickRef.current = runwayModelId;
    setRunwayDuration('');
    setRunwayResolution('');
  }, [runwayModelId]);

  // Each Higgsfield family has its own lengths, tiers and audio switch.
  const higgsfieldModelPickRef = useRef(higgsfieldModelId);
  useEffect(() => {
    if (higgsfieldModelPickRef.current === higgsfieldModelId) return;
    higgsfieldModelPickRef.current = higgsfieldModelId;
    setHiggsfieldDuration('');
    setHiggsfieldResolution('');
  }, [higgsfieldModelId]);

  // Each Veo model has its own lengths and inputs.
  const googleModelPickRef = useRef(googleModelId);
  useEffect(() => {
    if (googleModelPickRef.current === googleModelId) return;
    googleModelPickRef.current = googleModelId;
    setGoogleDuration('');
    setGoogleResolution('');
  }, [googleModelId]);

  const hostedLane = enabled[backend] ? backend : null;
  // Grok, fal.ai, reactor.inc and Runway are usability-gated on a configured
  // toggle or API key (mirrored from the server's isVideoModeUsable check):
  // only prompt/dims/source-image and a duration reach the provider. reactor
  // adds native clip-to-clip chaining via continue_from_clip_id; Runway offers
  // text mode for the models that render from a prompt alone. Gemini renders
  // in the PortOS Browser, so it has no key and no provider settings.
  const isGrok = hostedLane === 'grok';
  const isFal = hostedLane === 'fal';
  const isReactor = hostedLane === 'reactor';
  const isRunway = hostedLane === 'runway';
  const isGemini = hostedLane === 'gemini';
  const isHiggsfield = hostedLane === 'higgsfield';
  const isGoogle = hostedLane === 'google';
  const higgsfieldModel = getHiggsfieldVideoModel(higgsfieldModelId) || getHiggsfieldVideoModel(HIGGSFIELD_DEFAULT_VIDEO_MODEL);
  const googleModel = getGoogleVideoModel(googleModelId) || getGoogleVideoModel(GOOGLE_DEFAULT_VIDEO_MODEL);
  const falModel = getFalVideoModel(falModelId);
  const falResolutions = falVideoResolutions(falModel);
  const runwaySpecial = isRunway && RUNWAY_SPECIAL_VIDEO_MODES.includes(mode);
  const runwayPerformance = isRunway && mode === 'character-performance';
  const runwayModel = getRunwaySpecialVideoModel(runwayModelId) || getRunwayVideoModel(runwayModelId || RUNWAY_DEFAULT_IMAGE_VIDEO_MODEL);
  const runwaySizeModel = mode === 'text' && runwayModel?.textToVideo ? { ...runwayModel, size: runwayModel.textToVideo.size } : runwayModel;
  const runwayResolutions = runwayVideoResolutions(runwaySizeModel);

  // A model that needs a start frame cannot stay picked in Text mode: fall back to the catalog default (which renders from text).
  const runwayTextBlocked = isRunway && mode === 'text' && !runwayModelTakesText(getRunwayVideoModel(runwayModelId || RUNWAY_DEFAULT_IMAGE_VIDEO_MODEL));
  useEffect(() => {
    if (runwayTextBlocked) setRunwayModelId('');
  }, [runwayTextBlocked, setRunwayModelId]);

  // Restore a hosted job resumed via /active. Its `p.mode` is the queue
  // discriminator ('grok', 'fal', …), not a semantic video mode, so this sets
  // the backend switch and provider fields and returns the real mode to
  // restore — or null for a local job, whose `p.mode` already is one. The pick
  // refs move with the model id so the per-model reset above does not wipe
  // the restored length and size.
  const applyResumedLane = (p) => {
    if (p.mode === 'grok') {
      setBackend('grok');
      if (p.duration) setGrokDuration(p.duration);
      return imageOrText(p);
    }
    if (p.mode === 'fal') {
      setBackend('fal');
      if (p.duration) setFalDuration(p.duration);
      if (p.modelId) {
        falModelPickRef.current = p.modelId;
        setFalModelId(p.modelId);
      }
      if (p.resolution) setFalResolution(p.resolution);
      setFalGenerateAudio(p.generateAudio === true);
      return imageOrText(p);
    }
    if (p.mode === 'higgsfield') {
      setBackend('higgsfield');
      const family = getHiggsfieldVideoModel(p.modelId);
      if (family) {
        higgsfieldModelPickRef.current = family.id;
        setHiggsfieldModelId(family.id);
      }
      if (p.duration) setHiggsfieldDuration(String(p.duration));
      if (p.resolution) setHiggsfieldResolution(p.resolution);
      setHiggsfieldGenerateAudio(p.generateAudio === true);
      return imageOrText(p);
    }
    if (p.mode === 'google') {
      setBackend('google');
      const veo = getGoogleVideoModel(p.modelId);
      if (veo) {
        googleModelPickRef.current = veo.id;
        setGoogleModelId(veo.id);
      }
      if (p.duration) setGoogleDuration(String(p.duration));
      if (p.resolution) setGoogleResolution(p.resolution);
      setGoogleGenerateAudio(p.generateAudio === true);
      return imageOrText(p);
    }
    if (p.mode === 'gemini') {
      setBackend('gemini');
      return imageOrText(p);
    }
    if (p.mode === 'runway') {
      setBackend('runway');
      setRunwayInputs({ targetAspectRatio: p.targetAspectRatio, ratio: p.ratio, bodyControl: p.bodyControl, expressionIntensity: p.expressionIntensity, seed: p.seed });
      if (p.modelId) {
        runwayModelPickRef.current = p.modelId;
        setRunwayModelId(p.modelId);
      }
      if (p.duration) setRunwayDuration(String(p.duration));
      if (p.resolution) setRunwayResolution(p.resolution);
      return RUNWAY_SPECIAL_VIDEO_MODES.includes(p.videoMode) ? p.videoMode : p.videoMode === 'text' ? 'text' : 'image';
    }
    if (p.mode === 'reactor') {
      setBackend('reactor');
      if (p.continueFromClipId) setReactorClipId(p.continueFromClipId);
      if (p.seconds) setReactorSeconds(p.seconds);
      if (p.seed !== undefined && p.seed !== null) setReactorSeed(p.seed);
      if (p.aspect) setReactorAspect(p.aspect);
      return imageOrText(p);
    }
    return null;
  };

  return {
    backend, setBackend, hostedLane, applyResumedLane,
    isGrok, isFal, isReactor, isRunway, isGemini, isHiggsfield, isGoogle,
    grok: { grokDuration, setGrokDuration },
    fal: {
      falModel, falResolutions,
      falModelId, setFalModelId,
      falDuration, setFalDuration,
      falResolution, setFalResolution,
      falGenerateAudio, setFalGenerateAudio,
    },
    runway: {
      runwayModel, runwaySizeModel, runwayResolutions, runwaySpecial, runwayPerformance,
      runwayModelId, setRunwayModelId,
      runwayDuration, setRunwayDuration,
      runwayResolution, setRunwayResolution,
      runwayInputs, setRunwayInputs,
    },
    higgsfield: {
      higgsfieldModel,
      higgsfieldModelId, setHiggsfieldModelId,
      higgsfieldDuration, setHiggsfieldDuration,
      higgsfieldResolution, setHiggsfieldResolution,
      higgsfieldGenerateAudio, setHiggsfieldGenerateAudio,
    },
    google: {
      googleModel,
      googleModelId, setGoogleModelId,
      googleDuration, setGoogleDuration,
      googleResolution, setGoogleResolution,
      googleGenerateAudio, setGoogleGenerateAudio,
    },
    reactor: {
      reactorClipId, setReactorClipId,
      reactorSeconds, setReactorSeconds,
      reactorSeed, setReactorSeed,
      reactorAspect, setReactorAspect,
    },
  };
}

export default useVideoGenBackendCaps;
