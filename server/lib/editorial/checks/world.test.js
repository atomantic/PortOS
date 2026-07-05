import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { applyTemplate } from '../../promptTemplate.js';
import { canonWorldSummary, listChecks, getCheck } from '../checkRegistry.js';
import { worldChecks } from './world.js';

const STAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../data.reference/prompts/stages');
const readStage = (file) => readFileSync(join(STAGE_DIR, file), 'utf-8');

describe('worldbuilding-doctrine checks — registration (#2175)', () => {
  it('registers both world.* checks as enabled series-scope LLM checks', () => {
    const ids = worldChecks.map((c) => c.id).sort();
    expect(ids).toEqual(['world.cost-free-power', 'world.unforeshadowed-solution']);
    for (const id of ids) {
      const check = getCheck(id);
      expect(check, id).toBeTruthy();
      expect(check.scope, id).toBe('series');
      expect(check.kind, id).toBe('llm');
      expect(check.category, id).toBe('world');
      expect(check.defaultEnabled, id).toBe(true);
      expect(check.needsManuscript, id).toBe(true);
      // Reconciles against canon + the continuity-bible world-rule facts so an
      // established rule is not flagged.
      expect(check.sources, id).toContain('canon');
      expect(check.sources, id).toContain('continuityBible');
    }
  });

  it('both checks appear in the assembled registry (ordered slot present)', () => {
    const all = new Set(listChecks().map((c) => c.id));
    expect(all.has('world.unforeshadowed-solution')).toBe(true);
    expect(all.has('world.cost-free-power')).toBe(true);
  });

  it('both checks gate off when the manuscript is empty', () => {
    for (const check of worldChecks) {
      expect(check.gate({ manuscript: '' }), check.id).toBe(false);
      expect(check.gate({ manuscript: 'He drew the blade.' }), check.id).toBe(true);
    }
  });
});

describe('canonWorldSummary (#2175)', () => {
  it('returns empty string when no objects or places carry usable content', () => {
    expect(canonWorldSummary(null)).toBe('');
    expect(canonWorldSummary({})).toBe('');
    expect(canonWorldSummary({ objects: [], places: [] })).toBe('');
    // Nameless rows are skipped.
    expect(canonWorldSummary({ objects: [{ significance: 'x' }], places: [{ description: 'y' }] })).toBe('');
  });

  it('summarizes named artifacts with significance and places with recurring details', () => {
    const out = canonWorldSummary({
      objects: [{ name: 'The Ember Key', significance: 'burns the bearer to open a door' }],
      places: [{ name: 'The Ashfall', recurringDetails: 'perpetual grey snow' }],
    });
    expect(out).toContain('World canon');
    expect(out).toContain('The Ember Key: burns the bearer to open a door');
    expect(out).toContain('The Ashfall: perpetual grey snow');
    expect(out).toContain('Established artifacts / objects');
    expect(out).toContain('Established places');
  });

  it('falls back to description and slugline, and tolerates non-string fields', () => {
    const out = canonWorldSummary({
      objects: [{ name: 'Relic', description: 'a cracked orb' }],
      places: [{ slugline: 'EXT. THE VOID', recurringDetails: 42 }],
    });
    expect(out).toContain('Relic: a cracked orb');
    // Non-string recurringDetails is dropped; the slugline still names the place.
    expect(out).toContain('- EXT. THE VOID');
    expect(out).not.toContain('42');
  });
});

describe('worldbuilding-doctrine prompt rendering (#2175)', () => {
  it('unforeshadowed-solution: shows canon + world rules, and the final-part gate', () => {
    const prompt = readStage('pipeline-editorial-world-unforeshadowed-solution.md');
    const out = applyTemplate(prompt, {
      manuscript: '# Issue 1\n\nThe orb saved them.',
      canonWorld: 'CANON_BLOCK',
      worldRules: 'RULES_BLOCK',
      finalPart: 'true',
    });
    expect(out).toContain("Sanderson's First Law");
    expect(out).toContain('CANON_BLOCK');
    expect(out).toContain('RULES_BLOCK');
    expect(out).toContain('final part');
    expect(out).not.toContain('{{');
  });

  it('unforeshadowed-solution: hides canon block and shows the non-final PARTS warning when empty', () => {
    const prompt = readStage('pipeline-editorial-world-unforeshadowed-solution.md');
    const out = applyTemplate(prompt, {
      manuscript: '# Issue 1\n\nThe orb saved them.',
      canonWorld: '',
      worldRules: '',
      finalPart: '',
    });
    expect(out).not.toContain('World canon (already established)');
    expect(out).toContain('reading the manuscript in PARTS');
    expect(out).not.toContain('{{');
  });

  it('cost-free-power: shows canon + world rules and cites the Second Law', () => {
    const prompt = readStage('pipeline-editorial-world-cost-free-power.md');
    const out = applyTemplate(prompt, {
      manuscript: '# Issue 1\n\nShe teleported the army home, effortlessly.',
      canonWorld: 'CANON_BLOCK',
      worldRules: 'RULES_BLOCK',
    });
    expect(out).toContain("Sanderson's Second Law");
    expect(out).toContain('CANON_BLOCK');
    expect(out).toContain('RULES_BLOCK');
    expect(out).not.toContain('{{');
  });
});
