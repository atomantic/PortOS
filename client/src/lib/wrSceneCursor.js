// Resolve which script scene the writer's caret currently sits in.
//
// Writers Room script analyses don't store prose offsets — scenes are matched
// to the manuscript by text (this mirrors WorkEditor's jumpToScene, which
// locates a scene by searching for its heading, then a summary/action snippet).
// For the live render preview we need the inverse: given a caret offset, find
// the scene whose anchor text starts at the greatest index that is still at or
// before the caret. That's the scene the caret is reading "inside of".
//
// Pure + client-only (it operates on the editor body string + a numeric
// offset), so it has no server mirror. Returns the matched scene object plus
// the 1-based scene number, or null when nothing matches.

// Find the prose offset where a scene begins, trying the LLM heading (with the
// markdown prefixes the editor uses) first, then a summary/action snippet.
// Searches from `fromIndex` so callers resolving scenes IN ORDER can advance
// past each match — otherwise scenes that share a heading/snippet (a recurring
// "INT. KITCHEN" slugline, repeated action text) would all collapse onto the
// first occurrence and a cursor in a later scene could resolve to an earlier
// one. Returns -1 when the scene can't be located at or after `fromIndex`.
export function sceneAnchorIndex(body, scene, fromIndex = 0) {
  if (!body || !scene) return -1;
  const heading = scene.heading || '';
  for (const prefix of ['## ', '### ', '# ', '']) {
    if (!heading) break;
    const idx = body.indexOf(prefix + heading, fromIndex);
    if (idx >= 0) return idx;
  }
  for (const candidate of [scene.summary, scene.action]) {
    if (!candidate) continue;
    const snippet = String(candidate).trim().slice(0, 40);
    if (!snippet) continue;
    const idx = body.indexOf(snippet, fromIndex);
    if (idx >= 0) return idx;
  }
  return -1;
}

// Return { scene, sceneNumber } for the scene the caret at `cursorOffset` sits
// in, or null. Scenes are resolved IN ORDER with a moving search cursor so each
// scene maps to a strictly-increasing anchor position (duplicate headings don't
// collapse onto the same offset). The match is then the locatable scene with
// the greatest anchor index that is <= cursorOffset. sceneNumber is the 1-based
// index in the original scenes array (so it lines up with the storyboard
// numbering), not the position among locatable scenes. A scene that can't be
// located at/after the previous match is skipped without rewinding the cursor.
export function sceneAtCursor(scenes, body, cursorOffset) {
  if (!Array.isArray(scenes) || !scenes.length || !body) return null;
  const caret = Number.isFinite(cursorOffset) ? cursorOffset : body.length;
  let searchFrom = 0;
  let best = null;
  scenes.forEach((scene, i) => {
    const idx = sceneAnchorIndex(body, scene, searchFrom);
    if (idx < 0) return; // not locatable from here — skip, keep the cursor put
    searchFrom = idx + 1; // next scene must start strictly after this one
    if (idx <= caret) best = { scene, sceneNumber: i + 1, index: idx };
  });
  if (best) return { scene: best.scene, sceneNumber: best.sceneNumber };
  return null;
}
