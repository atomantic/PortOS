// Shared resolution presets for video generation. Companion to
// `imageGenResolutions.js` — both the image and video generators feed their
// preset table into the shared `components/media/ResolutionField.jsx` control
// (preset dropdown + "Custom…" W×H), so the size UX stays consistent across both.
//
// Video sizes follow LTX-2's preferred latent boundaries (multiples of 64 on
// each edge); the aspect-ratio hints in the labels surface common shapes the
// user picks for (16:9 social, 9:16 vertical, 2:3 portrait, 1:1 grid).
export const VIDEO_RESOLUTIONS = [
  { label: '512×320 (16:10)', w: 512, h: 320 },
  { label: '640×384 (5:3)', w: 640, h: 384 },
  { label: '704×448 (16:10)', w: 704, h: 448 },
  { label: '768×512 (3:2 default)', w: 768, h: 512 },
  { label: '1024×576 (16:9)', w: 1024, h: 576 },
  { label: '576×1024 (9:16)', w: 576, h: 1024 },
  { label: '512×768 (portrait)', w: 512, h: 768 },
  { label: '512×512 (1:1)', w: 512, h: 512 },
  { label: '768×768 (1:1)', w: 768, h: 768 },
];

// Pick the preset whose aspect ratio is closest to a source image's, so an I2V
// default doesn't cover-crop the subject out of a mismatched frame (the server
// resizes the source with force_original_aspect_ratio=increase,crop). Every
// preset is already 64-aligned, so the nearest-aspect preset IS the nearest
// 64-aligned size that matches the image — no rounding needed here. Aspect
// error is compared in log space so a too-wide and an equally-too-tall preset
// are penalised symmetrically. Returns `{ w, h }`, or null when the inputs are
// unusable (non-positive dims / empty preset list) so the caller can no-op.
export const snapAspectToImage = (presets, imgW, imgH) => {
  const w = Number(imgW);
  const h = Number(imgH);
  if (!(w > 0) || !(h > 0) || !Array.isArray(presets) || presets.length === 0) return null;
  const target = w / h;
  let best = null;
  let bestErr = Infinity;
  for (const p of presets) {
    if (!(p?.w > 0) || !(p?.h > 0)) continue;
    const err = Math.abs(Math.log((p.w / p.h) / target));
    if (err < bestErr) { bestErr = err; best = p; }
  }
  return best ? { w: best.w, h: best.h } : null;
};
