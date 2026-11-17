/**
 * Turning a 3D asset failure into something a person can act on.
 *
 * `glbFailureHint(error)` matches the message against a shared table (an HTML body reaching the glTF parser, a WebGL context failure, a 404) and returns `null` when nothing recognizes it, so a caller can tell "we know the cause" from "we don't";
 * `glbErrorText(error)` reads a message off whatever shape was thrown. The raw messages are useless alone (the glTF parser JSON.parses whatever it is handed, so an SPA-fallback HTML body surfaces as a JSON syntax error naming a `<`). Shared because the CoS avatars load remote GLBs too,
 * where a model 404 used to be reported as "this display has no WebGL" (#4688). Consumed by `media/GlbViewer.jsx` and `cos/CoSCanvasGuard.jsx`.
 */

// One table so every recognized cause reads the same way everywhere.
const FAILURE_HINTS = [
  [
    /Unexpected token '<'|<!DOCTYPE/i,
    'The server answered with a web page instead of the mesh file — the asset may be missing or the server may still be restarting.',
  ],
  [/webgl/i, 'This display cannot create a WebGL context, so 3D previews cannot render here.'],
  [/\b404\b|not found/i, 'The mesh file is no longer on disk.'],
];

/** The error's message, whatever shape the thrower used. */
export const glbErrorText = (error) => String(error?.message || error || '');

/** A sentence naming the cause, or `null` when nothing recognizes it (deliberately no generic catch-all, so a caller can tell "we know" from "we don't"). */
export function glbFailureHint(error) {
  const message = glbErrorText(error);
  return FAILURE_HINTS.find(([pattern]) => pattern.test(message))?.[1] || null;
}
