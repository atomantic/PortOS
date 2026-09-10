/**
 * Human labels for editorial and manuscript-completeness finding categories.
 *
 * This leaf is shared with the browser manuscript editor, so keep it pure and
 * dependency-free. Completeness-only categories remain here alongside the
 * categories declared by built-in editorial checks.
 */
export const FINDING_CATEGORY_LABELS = Object.freeze(Object.assign(Object.create(null), {
  'missing-content': 'Missing content',
  'arc-gap': 'Arc gap',
  arc: 'Character arc',
  'character-gap': 'Character gap',
  character: 'Character',
  plot: 'Plot structure',
  theme: 'Theme',
  casting: 'Casting',
  pacing: 'Pacing',
  continuity: 'Continuity',
  accuracy: 'Fact accuracy',
  style: 'Style',
  exposition: 'Exposition',
  lettering: 'Lettering',
  dialogue: 'Dialogue',
  naming: 'Naming',
  world: 'World',
  emotion: 'Emotion',
  opening: 'Opening',
  cliche: 'Cliché',
  prose: 'Prose',
  other: 'Note',
}));
