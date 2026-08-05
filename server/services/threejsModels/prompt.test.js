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
});
