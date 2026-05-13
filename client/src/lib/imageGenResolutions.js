// Shared resolution presets for image generation. Used by the standalone
// Image Gen page and the World Builder batch render so the size dropdown
// stays consistent everywhere.
//
// Entries without a `compatible` field are universal. The non-universal
// ones reflect real model constraints, not just style — Z-Image-Turbo and
// ERNIE were trained at 1024² and degrade past ~1280, and gpt-image-2's
// native sizes are 1024² / 1024×1536 / 1536×1024.
import { RUNNER_FAMILIES } from './runnerFamilies';

// `flux1` and `external` aren't members of RUNNER_FAMILIES — they're synthetic
// compatibility-only keys ('flux1' = mflux/diffusers fallback when no `runner`
// field is set; 'external' = Codex/API providers). Keep them as bare strings.
export const RESOLUTIONS = [
  { label: '512×512', w: 512, h: 512 },
  { label: '768×512', w: 768, h: 512 },
  { label: '512×768', w: 512, h: 768 },
  { label: '768×768', w: 768, h: 768 },
  { label: '1024×1024', w: 1024, h: 1024 },
  { label: '832×1216 (Flux portrait)', w: 832, h: 1216, compatible: ['flux1', RUNNER_FAMILIES.FLUX2, 'external'] },
  { label: '1216×832 (Flux landscape)', w: 1216, h: 832, compatible: ['flux1', RUNNER_FAMILIES.FLUX2, 'external'] },
  { label: '1024×576 (16:9)', w: 1024, h: 576 },
  { label: '576×1024 (9:16)', w: 576, h: 1024 },
  { label: '1536×1536 (hi-res square)', w: 1536, h: 1536, compatible: ['codex', RUNNER_FAMILIES.FLUX2] },
  { label: '1024×1536 (hi-res portrait)', w: 1024, h: 1536, compatible: ['codex', RUNNER_FAMILIES.FLUX2] },
  { label: '1536×1024 (hi-res landscape)', w: 1536, h: 1024, compatible: ['codex', RUNNER_FAMILIES.FLUX2] },
];

// Flux 1 (mflux/diffusers, `dev` / `schnell`) has no `runner` field — it's
// the fallback for local mode when nothing more specific matches.
export const compatibilityKey = (mode, runner) => {
  if (mode === 'codex') return 'codex';
  if (mode === 'external') return 'external';
  if (runner === RUNNER_FAMILIES.FLUX2
      || runner === RUNNER_FAMILIES.Z_IMAGE
      || runner === RUNNER_FAMILIES.ERNIE) {
    return runner;
  }
  return 'flux1';
};

export const filterResolutions = (mode, runner) => {
  const key = compatibilityKey(mode, runner);
  return RESOLUTIONS.filter((r) => !r.compatible || r.compatible.includes(key));
};
