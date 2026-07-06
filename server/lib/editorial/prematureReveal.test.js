import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { applyTemplate } from '../promptTemplate.js';
import { getCheck } from './checkRegistry.js';
import { revealGatedCanonSummary, revealGatedPayoffsSummary, PREMATURE_REVEAL_STAGE } from './checkInfra.js';

// #2178 — the premature-reveal editorial check (CWQE Phase 13). Pins the gate
// (only fires when the series authored reveal-gated canon AND a manuscript
// exists), the summary block the prompt consumes, and the shipped template's
// leak-vs-foreshadowing distinction + finalPart toggle.

const PROMPT = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../../data.reference/prompts/stages/pipeline-editorial-premature-reveal.md'),
  'utf-8',
);

describe('continuity.premature-reveal check gating (#2178)', () => {
  const check = getCheck('continuity.premature-reveal');

  it('is registered with the expected scope/kind/category', () => {
    expect(check).toBeTruthy();
    expect(check.scope).toBe('series');
    expect(check.kind).toBe('llm');
    expect(check.category).toBe('continuity');
    expect(check.needsManuscript).toBe(true);
  });

  it('gate is false without reveal-gated canon, false without a manuscript, true with both', () => {
    const gated = { characters: [{ name: 'Vex', revealIssue: 8 }], places: [], objects: [] };
    const ungated = { characters: [{ name: 'Mira' }], places: [], objects: [] };
    expect(check.gate({ manuscript: 'text', canon: gated })).toBe(true);
    expect(check.gate({ manuscript: 'text', canon: ungated })).toBe(false);
    expect(check.gate({ manuscript: '   ', canon: gated })).toBe(false);
    expect(check.gate({ manuscript: 'text', canon: null })).toBe(false);
  });
});

describe('revealGatedCanonSummary (#2178)', () => {
  it('renders reveal issue, hard spoiler, surface descriptor, and the gated fact', () => {
    const canon = {
      characters: [{
        name: 'Vex', physicalDescription: 'the true killer', background: 'poisoned the well',
        revealIssue: 8, surfaceDescriptor: 'a reclusive apothecary',
      }],
      objects: [{ name: 'Vial', description: 'the poison', spoiler: true }],
      places: [],
    };
    const out = revealGatedCanonSummary(canon);
    expect(out).toContain('Vex');
    expect(out).toContain('Issue 8');
    expect(out).toContain('a reclusive apothecary');
    expect(out).toContain('the true killer');
    expect(out).toContain('Vial');
    expect(out).toContain('HARD SPOILER');
  });

  it('returns empty string when nothing is gated', () => {
    expect(revealGatedCanonSummary({ characters: [{ name: 'A' }] })).toBe('');
  });
});

describe('revealGatedPayoffsSummary — Chekhov interaction (#2178)', () => {
  it('renders only numeric-gated entries as authored payoffs at their reveal issue', () => {
    const canon = {
      characters: [
        { name: 'Vex', physicalDescription: 'the true killer', revealIssue: 8 },
        { name: 'Ghost', description: 'the mastermind', spoiler: true }, // hard spoiler — no payoff issue
      ],
      objects: [], places: [],
    };
    const out = revealGatedPayoffsSummary(canon);
    expect(out).toContain('Vex');
    expect(out).toContain('Issue 8');
    expect(out).toContain('the true killer');
    // A hard spoiler has no scheduled payoff issue — excluded.
    expect(out).not.toContain('Ghost');
  });

  it('returns empty string when no numeric reveal gate exists', () => {
    expect(revealGatedPayoffsSummary({ characters: [{ name: 'Ghost', spoiler: true }] })).toBe('');
    expect(revealGatedPayoffsSummary({ characters: [{ name: 'A' }] })).toBe('');
  });
});

describe('pipeline-editorial-premature-reveal prompt rendering (#2178)', () => {
  const baseVars = (overrides = {}) => ({
    manuscript: '# Issue 2\n\nMara struck the match.',
    revealGatedCanon: 'character "Mara" (revealed in Issue 8 — must not appear before then).',
    finalPart: '',
    ...overrides,
  });

  it('renders the reveal-gated canon block and the leak-vs-foreshadowing rule', () => {
    const out = applyTemplate(PROMPT, baseVars());
    expect(out).toContain('Mara');
    expect(out).toContain('foreshadowing');
    expect(out).toContain('first-time reader');
  });

  it('renders the non-final-part guidance when finalPart is falsy and the final-part note when set', () => {
    expect(applyTemplate(PROMPT, baseVars({ finalPart: '' }))).toContain('reading the manuscript in PARTS');
    expect(applyTemplate(PROMPT, baseVars({ finalPart: 'true' }))).toContain('final part');
  });

  it('falls back gracefully when no reveal-gated canon is supplied', () => {
    const out = applyTemplate(PROMPT, baseVars({ revealGatedCanon: '' }));
    expect(out).toContain('No reveal-gated canon was supplied');
  });

  it('uses the correct stage key', () => {
    expect(PREMATURE_REVEAL_STAGE).toBe('pipeline-editorial-premature-reveal');
  });
});
