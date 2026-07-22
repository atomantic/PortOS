// Pure video-generation parameter helpers extracted from VideoGen.jsx (#2834).
// Side-effect-free — the model-memory calc, the FFLF/ltx2 frame-budget
// back-solve, the per-edge resolution bounds, and the mode-compatibility
// predicate. Kept in lib/ (not hooks/) because none touch React state; the
// page and any future consumer import them directly.

// Values follow LTX-2's 8k+1 latent boundary so the model doesn't silently
// snap. 241 = 10s @ 24fps is the comfortable single-pass ceiling on 48 GB
// at standard widths; the higher options (265–481) push past that and may
// swap or OOM at 1280×704. For reliable clips longer than ~10s, use Extend
// mode (renders past a source video, conditioning on its full latent) —
// see the hint under the Frames dropdown.
export const FRAME_OPTIONS = [25, 49, 73, 97, 121, 145, 169, 193, 217, 241, 265, 313, 361, 481];
export const FPS_OPTIONS = [16, 24, 30];

// Per-edge bounds for video: mirrors the videoGen route (64..2048) and the
// server's floor-to-multiple-of-64 (generateVideo in local.js). Shared by the
// ResolutionField control and the submit-time clamp so a hand-typed / mid-edit
// value can never POST an out-of-range or 0 dimension.
export const VIDEO_EDGE_BOUNDS = { min: 64, max: 2048, step: 64 };

// Resolve a video model's memory footprint in GB. Prefers the explicit
// `memoryGb` field, falling back to a "~NN GB" hint in the display name, then
// +Infinity so an unknown model never spuriously "fits" a memory budget.
export const videoModelMemoryGb = (model) => {
  const explicit = Number(model?.memoryGb);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const match = String(model?.name || '').match(/~\s*(\d+(?:\.\d+)?)\s*GB/i);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
};

// Mirror of server computeFflfSafeFrames (server/services/videoGen/local.js):
// the largest numFrames that fits the FFLF/ltx2 stage-2 pixel-frame budget at
// this resolution, rounded down to the LTX 8k+1 latent boundary. The budget
// itself comes from /status (`fflfLtx2PixelBudget`, which scales with the box's
// unified memory and honors the env override) so only this back-solve arithmetic
// is duplicated — not the constant. Lets the multi-keyframe picker reject
// out-of-budget indices before submit instead of letting the worker 400
// mid-render. Returns numFrames when it already fits or the budget is unknown
// (fail-open — the server still enforces the real cap).
export const computeFflfSafeFrames = (width, height, numFrames, budget) => {
  const wh = Number(width) * Number(height);
  const nf = Number(numFrames);
  const b = Number(budget);
  if (!(wh > 0) || !(nf > 0) || !(b > 0)) return nf;
  if (wh * nf <= b) return nf;
  const safeRaw = Math.floor(b / wh);
  const safeLatent = Math.max(1, Math.floor((safeRaw - 1) / 8));
  return safeLatent * 8 + 1;
};

// Mode-compatibility predicate for the Model dropdown. a2v requires the
// ltx2 runtime (dgrauet's pipeline) — the legacy mlx_video pipeline has no
// audio-conditioned mode, and Wan/Hunyuan don't either. Server enforces the
// same rule in routes/videoGen.js (A2V_REQUIRES_LTX2); filtering client-side
// keeps the dropdown honest so the user can't pick a doomed model.
export const isModelAllowedForMode = (model, mode) => {
  if (!model) return false;
  if (mode === 'a2v') return model.runtime === 'ltx2';
  return true;
};
