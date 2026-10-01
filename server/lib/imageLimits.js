// gpt-image-2 (codex backend) caps at 3840px per edge and 8,294,400 total
// pixels. Mirror the ceiling for every image-gen route. Local mflux can
// render up to 3840 in principle but is impractically slow past ~2048 — the
// UI's `compatible: ['codex']` filter on the 4K presets keeps those out of
// the local picker. Shared so the cap and refinement message stay identical
// across schemas.
export const MAX_IMAGE_EDGE = 3840;
export const MAX_IMAGE_PIXELS = 8_294_400;
