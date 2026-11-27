/**
 * Video model catalog — thin leaf over the hot-reloadable media-model registry.
 *
 * Lives apart from generateVideo.js so callers that only list or resolve models
 * do not import the whole local render engine. Lookups read the LIVE registry
 * (getVideoModels), so a model added at runtime via the HuggingFace installer is
 * renderable without a restart (issue #2124).
 */

import { getVideoModels, getDefaultVideoModelId } from '../../lib/mediaModels.js';
import { supportsWarmVideoBatch } from './batch.js';
import { a2vLoraStageCapable, byovRuntimeLoraCapable, modelAnchorsLastFrame, runtimeUsesMlx } from './runtimes.js';
import { publicVideoTextEncoderOptions } from '../../lib/videoTextEncoders.js';
import { publicContinuationCapability } from '../../lib/videoContinuity.js';

// Attach the runtime capabilities a model entry can't express on its own:
// whether an FFLF last frame is a real anchor, and whether the *installed* BYOV
// runner can apply user LoRAs (H3's DiT is quantized, so that depends on the
// pinned checkout plus PortOS's activation-space adapter — see runtimes.js
// `loraProbeArgs`). Both are declared in
// runtimes.js and surfaced here so the Video Gen form and videoLoraFamily() read
// them off the model instead of keeping their own lists. Applied by BOTH model
// resolvers, so the render path and the API payload can never disagree about
// what a model supports.
// Also attached: the substitutable prompt conditioners the model's runtime can
// load (lib/videoTextEncoders.js). Decorated rather than declared on the
// registry entry so the picker can never offer an option this build's runner
// has no key-remap for — and empty for every runtime without substitutions, so
// the client renders no picker instead of a one-entry select.
const decorateVideoModel = (m) => (m ? {
  ...m,
  supportsWarmBatch: supportsWarmVideoBatch(m),
  continuationCapability: publicContinuationCapability(m),
  a2vLoraStageCapable: a2vLoraStageCapable(m.runtime),
  lastFrameAnchored: modelAnchorsLastFrame(m),
  runtimeLoraCapable: byovRuntimeLoraCapable(m.runtime),
  textEncoderOptions: publicVideoTextEncoderOptions(m),
  // Does a render on this model put the display to sleep? An MLX render must
  // (spawnWatch.js sleeps it so WindowServer stops contending with Metal and
  // tripping the Apple GPU watchdog), and a user who is not told that reads the
  // dark screen as a crash and wakes it — which is the failure the sleep exists
  // to prevent. Decorated here rather than derived client-side so the warning
  // and the behaviour can never disagree about which runtimes do it. Whether it
  // will ACTUALLY happen also depends on the platform and the user's opt-out,
  // which are per-install facts reported once on /status as
  // `displaySleepOnRender`.
  sleepsDisplayDuringRender: runtimeUsesMlx(m.runtime),
} : m);

export const resolveVideoModel = (modelId) =>
  decorateVideoModel(getVideoModels().find((m) => m.id === modelId) || null);

export const listVideoModels = () => getVideoModels().map(decorateVideoModel);

export const defaultVideoModelId = (capabilities, preferredId) => getDefaultVideoModelId(capabilities, preferredId);

