import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { expandPartials, listPartialReferences } from './promptPartials.js';
import { applyTemplate } from './promptTemplate.js';

// The craft-anti-patterns partial (#2172) is shipped in data.reference and
// injected into two stage prompts. These pins guard against the partial being
// renamed/deleted (which would make buildPrompt throw at render time) and
// against the injection line being dropped from either stage on a future edit.
const REF = join(dirname(fileURLToPath(import.meta.url)), '../../data.reference/prompts');
const partialsDir = join(REF, '_partials');
const stage = (name) => readFileSync(join(REF, 'stages', name), 'utf-8');

describe('craft-anti-patterns partial (#2172)', () => {
  it('is referenced by both the prose and writers-room-continue stage prompts', () => {
    expect(listPartialReferences(stage('pipeline-prose.md'))).toContain('craft-anti-patterns');
    expect(listPartialReferences(stage('writers-room-continue.md'))).toContain('craft-anti-patterns');
  });

  it('expands through the fs-backed partial engine into the anti-pattern + Stability Trap content', async () => {
    const expanded = await expandPartials(stage('pipeline-prose.md'), { partialsDir });
    // The include marker is gone and the partial body landed inline.
    expect(expanded).not.toContain('{{> craft-anti-patterns }}');
    expect(expanded).toContain('No triadic sensory lists');
    expect(expanded).toContain('Zoom into the moment');
    expect(expanded).toContain('Stability Trap countermeasures');
    expect(expanded).toContain('Characters must end TRULY different');
    expect(expanded).toContain('A choice with no real cost is not a real choice');
  });

  it('survives the full buildPrompt pipeline (expandPartials → applyTemplate) with no unresolved partials', async () => {
    // partial → variable pass is exactly what promptService.buildPrompt does.
    for (const name of ['pipeline-prose.md', 'writers-room-continue.md']) {
      const expanded = await expandPartials(stage(name), { partialsDir });
      const rendered = applyTemplate(expanded, {});
      expect(rendered).not.toContain('{{>');
      expect(rendered).toContain('Include at least one genuinely surprising moment');
      // The construction recipe (#3594) must reach BOTH drafting stages — it is
      // the only positive-instruction block in the partial, and the thing that
      // makes the 70%-in-scene rule actionable rather than aspirational.
      expect(rendered).toContain('Zoom into the moment');
      expect(rendered).toContain('Emotions, shown on the body');
    }
  });

  it('carries the five "Zoom into the moment" construction elements (#3594)', () => {
    const body = readFileSync(join(partialsDir, 'craft-anti-patterns.md'), 'utf-8');
    const zoom = body.indexOf('## Zoom into the moment');
    const stability = body.indexOf('## Stability Trap countermeasures');
    // Positioned after the rule it operationalizes, before the Stability Trap block.
    expect(body.indexOf('At least 70% in-scene, not summary')).toBeLessThan(zoom);
    expect(zoom).toBeLessThan(stability);
    const section = body.slice(zoom, stability);
    for (const element of [
      'Location first',
      'Actions, in verbs',
      'Thoughts, raw',
      'Emotions, shown on the body',
      'Dialogue, quoted and specific',
    ]) {
      expect(section).toContain(element);
    }
  });

  it('carries no mustache variables of its own (context-agnostic across both stages)', () => {
    // A pure-prose partial must not introduce {{vars}} that would render
    // differently (or blank) depending on the including stage's context.
    const body = readFileSync(join(partialsDir, 'craft-anti-patterns.md'), 'utf-8');
    expect(body).not.toMatch(/\{\{[^>]/);
  });
});
