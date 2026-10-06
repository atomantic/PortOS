// The composition manifest the editor round-trips. Mode switches spread the
// stored manifest so scenes, takes, text cues, and generated section functions
// stay put.
export const EMPTY_COMPOSITION = {
  version: 1, mode: 'concat', textCues: [], style: { color: '#ffffff', font: 'sans' }, posterSec: null,
};

export const RENDER_STYLES = [
  ['concat', 'Footage'],
  ['composed', 'Composed'],
  ['code', 'Code-rendered'],
  ['document', 'Composition document'],
  ['eidoverse', 'Eidoverse Video'],
];

// One line per render style: what it is made from, whether Compose previews it live,
// whether it needs generated footage, and what it outputs. Shown beside the Setup picker.
export const RENDER_STYLE_HELP = {
  concat: 'Cuts the generated footage as is: needs footage generation, no live preview, output follows the clips. Typography cues do not render.',
  composed: 'Lays timed text over the generated footage: needs footage generation, no live preview, output follows the clips.',
  code: 'Draws the song in code with no footage: no generation needed, no live preview, limited 720p Canvas output.',
  document: 'Renders your composition document (Three.js or Canvas): no footage required, live preview in Make, 1080p at 24 fps by default.',
  eidoverse: 'Renders an Eidoverse scene from a saved script: no footage required, no live preview, needs a track analyzed first.',
};

export function compositionDraft(project, patch = {}) {
  const current = project?.composition || {};
  const style = { ...EMPTY_COMPOSITION.style, ...(current.style || {}), ...(patch.style || {}) };
  return { ...EMPTY_COMPOSITION, ...current, ...patch, style };
}

export function renderStyleLabel(mode) {
  return RENDER_STYLES.find(([value]) => value === mode)?.[1] || 'Footage';
}
