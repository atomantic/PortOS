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
// Returns -1 when the scene can't be located in the body.
export function sceneAnchorIndex(body, scene) {
  if (!body || !scene) return -1;
  const heading = scene.heading || '';
  for (const prefix of ['## ', '### ', '# ', '']) {
    if (!heading) break;
    const idx = body.indexOf(prefix + heading);
    if (idx >= 0) return idx;
  }
  for (const candidate of [scene.summary, scene.action]) {
    if (!candidate) continue;
    const snippet = String(candidate).trim().slice(0, 40);
    if (!snippet) continue;
    const idx = body.indexOf(snippet);
    if (idx >= 0) return idx;
  }
  return -1;
}

// Return { scene, sceneNumber } for the scene the caret at `cursorOffset` sits
// in, or null. The match is the locatable scene with the greatest anchor index
// that is <= cursorOffset; ties (multiple scenes resolving to the same index)
// keep the later one in list order. sceneNumber is the 1-based index in the
// original scenes array (so it lines up with the storyboard numbering), not the
// position among locatable scenes.
export function sceneAtCursor(scenes, body, cursorOffset) {
  if (!Array.isArray(scenes) || !scenes.length || !body) return null;
  const caret = Number.isFinite(cursorOffset) ? cursorOffset : body.length;
  let best = null;
  scenes.forEach((scene, i) => {
    const idx = sceneAnchorIndex(body, scene);
    if (idx < 0 || idx > caret) return;
    if (!best || idx >= best.index) {
      best = { scene, sceneNumber: i + 1, index: idx };
    }
  });
  if (best) return { scene: best.scene, sceneNumber: best.sceneNumber };
  return null;
}
