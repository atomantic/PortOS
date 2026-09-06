// Best-effort mapping from a FableLoom scene node's authored text into the
// `{ lines: [{ type, speaker, text }] }` shape /api/continuous-video expects
// (#6228). There is no existing FableLoom→continuous-video scene export, and
// prose/teleplay text is free-form — this is a lossy starting draft the
// Episode Composer always leaves user-editable, not a round-trip parser.

const CUE_RE = /^[A-Z][A-Z0-9 .,'()-]{1,59}$/; // total length capped at 60 (matches looksLikeCue's guard)

/** True for a short all-caps line that reads as a teleplay character cue. */
const looksLikeCue = (line) => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 60) return false;
  if (!CUE_RE.test(trimmed)) return false;
  return /[A-Z]/.test(trimmed) && trimmed === trimmed.toUpperCase();
};

/**
 * Parse one FableLoom node's text into continuous-video scene lines.
 * `format` 'teleplay' looks for ALL-CAPS character cues followed by dialogue;
 * anything else (including 'prose') is imported as a single action line.
 * Blank lines and slugline-looking lines (`INT. ...` / `EXT. ...`) are dropped.
 */
export function parseNodeTextToLines(text, { format = 'prose' } = {}) {
  const raw = typeof text === 'string' ? text : '';
  if (!raw.trim()) return [];
  const rawLines = raw.split('\n').map((l) => l.trim()).filter(Boolean);

  if (format !== 'teleplay') {
    return [{ type: 'action', text: raw.trim() }];
  }

  const lines = [];
  let actionBuffer = [];
  const flushAction = () => {
    if (actionBuffer.length) {
      lines.push({ type: 'action', text: actionBuffer.join(' ') });
      actionBuffer = [];
    }
  };

  for (let i = 0; i < rawLines.length; i += 1) {
    const line = rawLines[i];
    if (/^(INT\.|EXT\.)/.test(line)) continue; // slugline — not a spoken/action line
    if (looksLikeCue(line)) {
      flushAction();
      const speaker = line.replace(/\(.*\)$/, '').trim();
      const next = rawLines[i + 1];
      if (next && !looksLikeCue(next) && !/^(INT\.|EXT\.)/.test(next)) {
        lines.push({ type: 'dialogue', speaker, text: next });
        i += 1;
      }
      continue;
    }
    actionBuffer.push(line);
  }
  flushAction();
  return lines;
}

/**
 * Map a FableLoom loom's episode nodes into draft continuous-video scenes —
 * one scene per node, in node order. Nodes with no importable lines are
 * skipped.
 */
export function loomEpisodeToDraftScenes(episode, { format = 'prose' } = {}) {
  const nodes = Array.isArray(episode?.nodes) ? episode.nodes : [];
  return nodes
    .map((node) => ({
      sceneId: node.id,
      location: node.title || undefined,
      lines: parseNodeTextToLines(node.prose, { format }),
    }))
    .filter((scene) => scene.lines.length > 0);
}
