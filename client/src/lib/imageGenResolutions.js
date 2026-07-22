// Shared resolution presets for image generation. Used by the standalone
// Image Gen page and the Universe Builder batch render so the size dropdown
// stays consistent everywhere.
//
// Entries without a `compatible` field are universal. The non-universal
// ones reflect real model constraints, not just style — Z-Image-Turbo and
// ERNIE were trained at 1024² and degrade past ~1280, and gpt-image-2's
// native sizes are 1024² / 1024×1536 / 1536×1024.
import { RUNNER_FAMILIES } from './runnerFamilies';
import { IMAGE_GEN_MODE } from './imageGenBackends';

// `flux1` and `external` aren't members of RUNNER_FAMILIES — they're synthetic
// compatibility-only keys ('flux1' = mflux/diffusers fallback when no `runner`
// field is set; 'external' = Codex/API providers). Keep them as bare strings.
export const RESOLUTIONS = [
  { label: '512×512', w: 512, h: 512 },
  { label: '768×512', w: 768, h: 512 },
  { label: '512×768', w: 512, h: 768 },
  { label: '768×768', w: 768, h: 768 },
  { label: '1024×1024', w: 1024, h: 1024 },
  { label: '832×1216 (Flux portrait)', w: 832, h: 1216, compatible: ['flux1', RUNNER_FAMILIES.FLUX2, RUNNER_FAMILIES.QWEN, RUNNER_FAMILIES.HIDREAM, 'external'] },
  { label: '1216×832 (Flux landscape)', w: 1216, h: 832, compatible: ['flux1', RUNNER_FAMILIES.FLUX2, RUNNER_FAMILIES.QWEN, RUNNER_FAMILIES.HIDREAM, 'external'] },
  { label: '1024×576 (16:9)', w: 1024, h: 576 },
  { label: '576×1024 (9:16)', w: 576, h: 1024 },
  { label: '1536×1536 (hi-res square)', w: 1536, h: 1536, compatible: ['codex', RUNNER_FAMILIES.FLUX2, RUNNER_FAMILIES.QWEN, RUNNER_FAMILIES.HIDREAM] },
  { label: '1024×1536 (hi-res portrait)', w: 1024, h: 1536, compatible: ['codex', RUNNER_FAMILIES.FLUX2, RUNNER_FAMILIES.QWEN, RUNNER_FAMILIES.HIDREAM] },
  { label: '1536×1024 (hi-res landscape)', w: 1536, h: 1024, compatible: ['codex', RUNNER_FAMILIES.FLUX2, RUNNER_FAMILIES.QWEN, RUNNER_FAMILIES.HIDREAM] },
  // Past Qwen's documented ~1664 long-edge support window — renders coherently
  // in practice but is out-of-distribution; keep flagged "experimental."
  { label: '1328×2048 (Qwen comic draft — experimental)', w: 1328, h: 2048, compatible: [RUNNER_FAMILIES.QWEN] },
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

// Mirror of server/lib/validation.js MAX_IMAGE_EDGE / MAX_IMAGE_PIXELS — the
// gpt-image-2 / image-gen route ceiling (each edge ≤ 3840, total ≤ 8,294,400).
// Keep in sync with that module.
export const MAX_IMAGE_EDGE = 3840;
export const MAX_IMAGE_PIXELS = 8_294_400;

// Clamp arbitrary source dimensions (e.g. an uploaded photo) down to the
// server's per-edge and total-pixel caps, preserving aspect ratio and snapping
// to a multiple of 8 (runner-friendly). Returns integer { width, height } ≥ 64,
// or null for non-finite/non-positive input. Already-valid sizes pass through
// unchanged. Use this before seeding the resolution from any user-supplied image
// so Generate doesn't 400 on imageEdgeSchema / refineImagePixelCap.
export function clampImageDimensions(width, height) {
  let w = Number(width);
  let h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) return null;
  const edgeScale = Math.min(1, MAX_IMAGE_EDGE / Math.max(w, h));
  w *= edgeScale; h *= edgeScale;
  const pixelScale = Math.min(1, Math.sqrt(MAX_IMAGE_PIXELS / (w * h)));
  w *= pixelScale; h *= pixelScale;
  // Floor to a multiple of 8 so the snap never pushes us back over a cap.
  const snap = (n) => Math.max(64, Math.floor(n / 8) * 8);
  return { width: snap(w), height: snap(h) };
}

// Clamp a single hand-typed edge (width or height) to a runner's per-edge
// bounds — mirrors the server so the custom-dimension inputs can't submit a
// value that 400s. Non-finite / ≤0 / below-min input snaps to the `min` floor;
// oversized caps at `max`; fractional input floors (runners want integer
// pixels). When `step > 1`, the result is snapped DOWN to the nearest multiple
// of `step` (still ≥ min) so the displayed value reflects what the runner will
// actually render (image: multiples of 8; video: the server floors to 64).
//
// Defaults to the image-gen ceiling ([64, MAX_IMAGE_EDGE], step 1) so existing
// image callers keep working with no `bounds` argument; video passes
// `{ min: 64, max: 2048, step: 64 }`.
export function clampImageEdge(value, { min = 64, max = MAX_IMAGE_EDGE, step = 1 } = {}) {
  let n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < min) return min;
  n = Math.min(max, n);
  if (step > 1) n = Math.max(min, Math.floor(n / step) * step);
  return n;
}

// Sentinel dropdown value for "enter arbitrary width/height" — distinct from
// any preset label so the resolution <select> can toggle the custom inputs.
export const CUSTOM_RESOLUTION_VALUE = '__custom__';

// Flux 1 (mflux/diffusers, `dev` / `schnell`) has no `runner` field — it's
// the fallback for local mode when nothing more specific matches.
const NATIVE_RUNNER_KEYS = new Set([
  RUNNER_FAMILIES.FLUX2,
  RUNNER_FAMILIES.Z_IMAGE,
  RUNNER_FAMILIES.ERNIE,
  RUNNER_FAMILIES.QWEN,
  RUNNER_FAMILIES.HIDREAM,
]);

export const compatibilityKey = (mode, runner) => {
  if (mode === IMAGE_GEN_MODE.CODEX) return 'codex';
  // Grok's image tools are prompt/aspect-ratio driven like codex — width and
  // height are hints mapped to the nearest supported ratio, so it shares the
  // codex preset list rather than getting its own compat key.
  if (mode === IMAGE_GEN_MODE.GROK) return 'codex';
  if (mode === IMAGE_GEN_MODE.EXTERNAL) return 'external';
  if (NATIVE_RUNNER_KEYS.has(runner)) return runner;
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
