// Video tiling options. The mode list is the server's (server/lib/videoTiling.js,
// also the video-gen route enums); this file only attaches labels. A new mode
// needs a label here — the labels test fails until it has one.
import { VIDEO_TILING_MODES } from '../../../server/lib/videoTiling.js';

const TILING_LABELS = {
  auto: 'Auto (recommended)',
  none: 'None (fastest, more VRAM)',
  spatial: 'Spatial only',
  temporal: 'Temporal only',
};

export const VIDEO_TILING_OPTIONS = VIDEO_TILING_MODES.map((value) => ({ value, label: TILING_LABELS[value] }));

export const VIDEO_TILING_ENUM_SET = new Set(VIDEO_TILING_OPTIONS.map((o) => o.value));

export function normalizeVideoTiling(value) {
  return typeof value === 'string' && VIDEO_TILING_ENUM_SET.has(value) ? value : undefined;
}
