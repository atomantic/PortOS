/** Shared Music Video clip upscaler choices and credential-dependent defaults. */

import { DEFAULT_FAL_SEEDVR2_TARGET_RESOLUTION } from '../videoGenRequestFields.js';

export const MUSIC_VIDEO_UPSCALERS = Object.freeze({
  'fal-seedvr2': 'fal.ai SeedVR2',
  lanczos: 'Lanczos',
  'local-ltx25': 'Local LTX 2.5',
  'fal-topaz': 'Topaz Labs',
  realesrgan: 'Real-ESRGAN',
});

export const defaultMusicVideoUpscaler = (falConfigured) => falConfigured ? 'fal-seedvr2' : 'lanczos';

export function musicVideoUpscaleSettings(settings, falConfigured = false) {
  return {
    upscaleMethod: settings?.upscaleMethod ?? defaultMusicVideoUpscaler(falConfigured),
    upscaleTargetResolution: settings?.upscaleTargetResolution ?? DEFAULT_FAL_SEEDVR2_TARGET_RESOLUTION,
  };
}
