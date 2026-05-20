// Shared resolution presets for image generation. Used by the standalone
// Image Gen page and the Universe Builder batch render so the size dropdown
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
  // US comic-book trim presets — 6.625"×10.25" = 1.547:1 aspect, the real
  // standard. Distinct from "portrait" because comic pages are squarer than
  // 2:3. Codex-only: every dimension here exceeds the implicit local-runner
  // ceilings used by the entries above (flux1 ≤1216, FLUX2 ≤1536, Z-Image /
  // ERNIE degrade past ~1280).
  { label: '1280×1972 (comic page — draft)', w: 1280, h: 1972, compatible: ['codex'] },
  { label: '1920×2951 (comic page — hi-res, margin)', w: 1920, h: 2951, compatible: ['codex'] },
  { label: '1988×3056 (comic page — hi-res, full bleed)', w: 1988, h: 3056, compatible: ['codex'] },
  // gpt-image-2 final-render presets: hard ceiling is each edge ≤ 3840 and
  // total ≤ 8,294,400 pixels. All three below sit exactly at the pixel cap
  // — pick aspect by shape. Codex-only because mflux/diffusers are too slow
  // at this resolution to be practical (and the smaller models degrade).
  { label: '3840×2160 (4K landscape)', w: 3840, h: 2160, compatible: ['codex'] },
  { label: '2160×3840 (4K portrait)', w: 2160, h: 3840, compatible: ['codex'] },
  { label: '2880×2880 (4K square)', w: 2880, h: 2880, compatible: ['codex'] },
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

// Shared dropdown resolver — find the matching preset for an arbitrary w/h
// pair (returning its preset label) or fall back to a `${w}×${h}` custom
// label so the dropdown can render an "(custom)" option for unmatched
// dimensions. Works on any list shaped like RESOLUTIONS / VIDEO_RESOLUTIONS,
// so both Image Gen and Video Gen consume the same helper.
export const resolveResolutionLabel = (list, w, h) => {
  const matched = list.find((r) => r.w === w && r.h === h);
  if (matched) return { matched, label: matched.label };
  if (!w || !h) return { matched: null, label: '' };
  return { matched: null, label: `${w}×${h}` };
};
