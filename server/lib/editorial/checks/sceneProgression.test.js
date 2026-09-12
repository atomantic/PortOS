import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { applyTemplate } from '../../promptTemplate.js';

const PROMPT = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../data.reference/prompts/stages/pipeline-editorial-plot-structure.md',
  ),
  'utf-8',
);

const render = (overrides = {}) => applyTemplate(PROMPT, {
  manuscript: '# Issue 7\n\nMara asks Ivo to trust her again.',
  authoredSetups: '',
  plotlineMap: '',
  sceneMap: 'Scenes (from the reverse outline):\n- Issue 7: Kitchen appeal',
  finalPart: 'true',
  ...overrides,
});

describe('plot-structure scene-progression prompt (#7205)', () => {
  it('distinguishes a repeated tactic from repeated wording and requires a concrete repair', () => {
    const out = render();

    expect(out).toContain('The defect is repeated strategy or a missing causal turn, not repeated wording.');
    expect(out).toMatch(/`problem` must name\s+the repeated tactic/);
    expect(out).toMatch(/one concrete action, discovery, consequence, change of tactic, or better entry\/exit/);
  });

  // These assertions pin the shipped reviewer instructions; they do not pretend
  // a stubbed model response can prove literary judgment.
  it.each([
    ['one tactic in new words', 'no deed, discovery, leverage, decision, or consequence'],
    ['repeated phrase gains leverage', /each beat changes what Mara and the audience\s+know/],
    ['quiet relationship turn', 'their relationship and future options have changed'],
    ['honest transition', 'It performs its connective job'],
  ])('ships the original %s calibration case', (_name, evidence) => {
    expect(render()).toMatch(evidence instanceof RegExp ? evidence : new RegExp(evidence));
  });

  it('forbids whole-scene claims from incomplete chunks or a trimmed scene map', () => {
    const out = render({ finalPart: '', sceneMap: '' });

    expect(out).toContain("may begin after a scene's opening or end before its resolution");
    expect(out).toContain('trimmed/absent scene-map entry');
    expect(out).toMatch(/including in a\s+non-final part/);
    expect(out).toContain('You are seeing an EARLIER part');
    expect(out).not.toMatch(/\{\{[#^/]?[\w.]+\}\}/);
  });

  it('preserves quiet, static, connective, and repetition-with-new-meaning passages', () => {
    const out = render();

    expect(out).toContain('quiet, contemplative, connective, or deliberately static scene');
    expect(out).toContain('changing audience knowledge');
    expect(out).toMatch(/Do not recommend deleting a scene\s+solely because it is quiet or static/);
  });
});
