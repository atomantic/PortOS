// Single source of truth for video tiling modes. Consumed by:
//   - components/videoGen/AdvancedParamsPanel.jsx — the <select> options.
//   - pages/VideoGen.jsx — the remix-prefill guard (VIDEO_TILING_ENUM_SET).
//   - hooks/useMediaPreviewActions.js — the Remix URL builder.
// The server's z.enum in server/routes/videoGen.js must match these values;
// add a new mode here and to the server enum together.
export const VIDEO_TILING_OPTIONS = [
  { value: 'auto', label: 'Auto (recommended)' },
  { value: 'none', label: 'None (fastest, more VRAM)' },
  { value: 'spatial', label: 'Spatial only' },
  { value: 'temporal', label: 'Temporal only' },
];

export const VIDEO_TILING_ENUM_SET = new Set(VIDEO_TILING_OPTIONS.map((o) => o.value));

export function normalizeVideoTiling(value) {
  return typeof value === 'string' && VIDEO_TILING_ENUM_SET.has(value) ? value : undefined;
}
