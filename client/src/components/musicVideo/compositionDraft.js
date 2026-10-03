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

export function compositionDraft(project, patch = {}) {
  const current = project?.composition || {};
  const style = { ...EMPTY_COMPOSITION.style, ...(current.style || {}), ...(patch.style || {}) };
  return { ...EMPTY_COMPOSITION, ...current, ...patch, style };
}

export function renderStyleLabel(mode) {
  return RENDER_STYLES.find(([value]) => value === mode)?.[1] || 'Footage';
}
