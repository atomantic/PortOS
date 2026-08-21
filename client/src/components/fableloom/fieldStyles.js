import { isTeleplayFormat } from './loomFormats';

// Shared form styling for the FableLoom surfaces — one source for the input
// and label classes the index form, episode drawer, and scene editor all use.
export const fieldClass = 'w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm';
export const labelClass = 'block text-xs font-medium text-port-text-muted mb-1';

// A teleplay carries its own line breaks (slugline / action / cue / dialogue),
// so it reads monospaced wherever it is shown — one token, composed into both
// the display class and the editor's field class, so tuning the look is a
// one-line change rather than two that can drift.
const TELEPLAY_TEXT = 'font-mono text-[13px] leading-relaxed';

// How a scene's text is DISPLAYED, per the loom's format. Both keep
// `whitespace-pre-wrap` — an authored blank line is meaningful either way.
export const sceneProseClass = (format) => (isTeleplayFormat(format)
  ? `${TELEPLAY_TEXT} whitespace-pre-wrap`
  : 'text-sm whitespace-pre-wrap');

/** The scene textarea in the editor, sized and typeset for the format. */
export const sceneFieldClass = (format) => (isTeleplayFormat(format) ? `${fieldClass} ${TELEPLAY_TEXT}` : fieldClass);
