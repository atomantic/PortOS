/**
 * Turning a 3D asset failure into something a person can act on.
 *
 * Turns a 3D asset failure into an actionable sentence. `glbFailureHint(error)` matches the message
 * against a shared table (an HTML body reaching the glTF parser, a WebGL context failure, a 404) and
 * returns `null` when nothing recognizes it — so a caller can tell "we know the cause" from "we don't"
 * and fall back to the raw text. `glbErrorText(error)` reads a message off whatever shape was thrown.
 * Shared because the CoS avatars load remote GLBs too: every caught error there used to be reported as
 * "this display has no WebGL", sending the user to change an unrelated setting (#4688). Consumed by
 * `media/GlbViewer.jsx` and `cos/CoSCanvasGuard.jsx`.
 *
 * The raw messages are useless on their own: the glTF parser JSON.parses
 * whatever bytes it is handed, so a 200 HTML body (an SPA fallback answering a
 * path that isn't really served) surfaces as a JSON syntax error naming a `<`
 * token. Shared rather than private to the GLB viewer because the CoS avatars
 * load remote GLBs too, and a model 404 there used to be reported as "this
 * display has no WebGL" — sending the user to change an unrelated setting.
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

/**
 * A sentence naming the cause, or `null` when nothing here recognizes it —
 * deliberately not a generic catch-all string, so a caller can tell "we know
 * what went wrong" from "we don't" and render accordingly.
 */
export function glbFailureHint(error) {
  const message = glbErrorText(error);
  return FAILURE_HINTS.find(([pattern]) => pattern.test(message))?.[1] || null;
}
