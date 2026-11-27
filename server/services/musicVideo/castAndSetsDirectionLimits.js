/** Bounds shared by Cast & Sets response parsing, normalization and director edits. */
export const CAST_SETS_LIMITS = Object.freeze({
  looks: { min: 1, max: 4 },
  sets: { min: 3, max: 8 },
  tests: { min: 2, max: 4 },
  rules: 6,
  expressions: 8,
  questions: 4,
  overlayElements: 4,
  // Supporting cast the model invents. Catalog-linked supporting characters the
  // director cast (fixedSupportingCast) never count against it: each one keeps
  // its sheet, bounded only by the project's own subject cap.
  cast: 4,
  // Recurring objects (cameras, instruments, vehicles, signature items) on one prop sheet.
  props: 6,
  fixedCast: 24,
  forms: 3,
});
export const CAST_SETS_IMAGE_ROLES = Object.freeze(['background', 'texture', 'decoration', 'cutout']);
export const TEXT = 1000;
export const SHORT = 120;
export const HEIGHT = 80;
