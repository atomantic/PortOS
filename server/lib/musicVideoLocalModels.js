/**
 * Which local video models can render which Music Video shot. A cutaway
 * animates its still, so it needs an image-to-video model; a performance shot
 * (lip-sync or music-driven) renders from its still and the song's slice, so
 * it needs an audio-to-video model PortOS hands that slice to: the LTX-2
 * family, or MiniMax H3 Ref2VA, which takes image + audio only. Shared by the
 * shot card's model picker, the project's renderer picker and the server's
 * submission checks, so the picker never offers a model the render refuses.
 */
import { MINIMAX_H3_REF2VA_RUNTIME, isLtx2FamilyRuntime } from './runners.js';
import { resolveVideoSupportedModes } from './videoModeProfiles.js';

/** Whether `model` can animate a cutaway's still. */
export const localModelRendersCutaway = (model) => !!model && resolveVideoSupportedModes(model).includes('image');

/** Whether `model` can render a performance shot from its still and the song slice. */
export const localModelRendersPerformance = (model) => !!model
  && resolveVideoSupportedModes(model).includes('a2v')
  && (isLtx2FamilyRuntime(model.runtime) || model.runtime === MINIMAX_H3_REF2VA_RUNTIME);

/** The local models a shot can render on (performance shots, or cutaways). */
export const localMusicVideoModels = (models, performance) => (Array.isArray(models) ? models : [])
  .filter(performance ? localModelRendersPerformance : localModelRendersCutaway);
