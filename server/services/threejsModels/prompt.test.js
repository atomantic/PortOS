import { describe, expect, it } from 'vitest';
import { buildThreejsGenerationPrompt } from './prompt.js';

const build = (overrides = {}) => buildThreejsGenerationPrompt({
  sourcePath: '/tmp/reference.png',
  name: 'Example Model',
  ...overrides,
});

describe('buildThreejsGenerationPrompt', () => {
  it('documents the surface-relief flag in the parts shape and tells the model when to set it', () => {
    const prompt = build();
    // Undocumented, the flag is never emitted and every model disassembles into
    // a comb of slivers.
    expect(prompt).toContain('"explodeWithParent":false');
    expect(prompt).toContain('"explodeWithParent":true on surface relief');
    for (const relief of ['serrations', 'stria', 'trim', 'port floors']) {
      expect(prompt).toContain(relief);
    }
  });

  it('gates on the model coming apart into readable components', () => {
    expect(build()).toContain('The model must come apart into readable components');
  });

  it('says when extrude is the WRONG answer and gates on cross-section', () => {
    const prompt = build();
    // Selling extrude for silhouettes without naming its failure mode is how a
    // whole model ends up as a stack of unbevelled slabs.
    expect(prompt).toContain('When extrude is the WRONG answer');
    expect(prompt).toContain('"bevelEnabled":true');
    expect(prompt).toContain('must not have every identity part flat along one axis');
  });

  it('carries the reference path, name, and direction into the prompt', () => {
    const prompt = build({ prompt: 'Match the brass finish.' });
    expect(prompt).toContain('/tmp/reference.png');
    expect(prompt).toContain('Example Model');
    expect(prompt).toContain('Match the brass finish.');
  });

  it('switches to a refinement pass when a current spec is supplied', () => {
    const prompt = build({ currentSpec: { schemaVersion: 1, name: 'Example Model' }, feedback: 'Thin the handle.' });
    expect(prompt).toContain('This is a refinement pass');
    expect(prompt).toContain('Thin the handle.');
    expect(build()).not.toContain('This is a refinement pass');
  });

  describe('subject family', () => {
    it('leaves the prompt byte-identical when no family is chosen', () => {
      // The taxonomy is a narrowing the user opts into. If the default path
      // drifted even slightly, every existing install's generations would change
      // behavior without anyone asking for it.
      const baseline = build();
      expect(build({ family: null })).toBe(baseline);
      expect(build({ family: 'general' })).toBe(baseline);
      expect(build({ family: 'not-a-family' })).toBe(baseline);
      expect(baseline).not.toContain('SUBJECT FAMILY');
    });

    it('splices the checklist and its extra quality gates when a family is chosen', () => {
      const prompt = build({ family: 'vehicle' });
      expect(prompt).toContain('SUBJECT FAMILY — Vehicle');
      expect(prompt).toContain('Cockpit or cabin');
      expect(prompt).toContain('subject-family checklist is either built and inventoried');
      expect(prompt).toContain('The checklist is the floor');
    });

    it('keeps the family checklist alongside refinement feedback rather than replacing it', () => {
      // A refinement is where an under-observed component is most likely to get
      // fixed, so dropping the checklist on the second pass would defeat it.
      const prompt = build({
        family: 'architecture',
        currentSpec: { schemaVersion: 1, name: 'Example Model' },
        feedback: 'Deepen the window reveals.',
      });
      expect(prompt).toContain('This is a refinement pass');
      expect(prompt).toContain('Deepen the window reveals.');
      expect(prompt).toContain('SUBJECT FAMILY — Building / structure');
    });
  });
});
