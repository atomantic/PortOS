import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { describe, it, expect } from 'vitest';

import { getCheck } from '../checkRegistry.js';

const STAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../data.reference/prompts/stages');
const readStage = (file) => readFileSync(join(STAGE_DIR, file), 'utf-8');

// Three checks now judge interiority and a fourth judges told emotion, all over
// the same passages. The only thing keeping them from returning duplicate
// findings on one paragraph is that each prompt names the others' territory as
// out of scope — so the boundaries are asserted here rather than left to drift
// the next time one of these prompts is edited (#3593).
describe('interiority.register — prompt boundaries against its neighbours (#3593)', () => {
  const prompt = readStage('pipeline-editorial-interiority-register.md');

  it('renders the manuscript variable the check feeds it', () => {
    expect(prompt).toContain('{{manuscript}}');
  });

  it('scopes told emotion out to prose.telling-emotion and missing interiority out to its siblings', () => {
    const doNotFlag = prompt.slice(prompt.indexOf('Do NOT flag:'));
    expect(doNotFlag).toContain('prose.telling-emotion');
    expect(doNotFlag).toContain('interiority.protagonist');
    expect(doNotFlag).toContain('scene.interiority-balance');
  });

  it('tells the model to flag the uniform-cast pattern once rather than per passage', () => {
    expect(prompt).toMatch(/do not emit a finding per passage/i);
  });

  it('asks for a register shift rather than a rewrite, matching the registry description', () => {
    expect(prompt).toMatch(/do NOT rewrite the/i);
    expect(getCheck('interiority.register').description).toContain('rather than rewriting the passage');
  });
});
