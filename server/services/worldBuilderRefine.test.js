import { describe, it, expect } from 'vitest';
import { __testing } from './worldBuilderRefine.js';

const { extractRefinementJson, buildWorldRefinePrompt } = __testing;

describe('worldBuilderRefine.extractRefinementJson', () => {
  it('parses a raw refinement object', () => {
    const obj = {
      starterPrompt: 'a darker scavenger world',
      stylePrompt: 'gritty palette, deep shadows',
      negativePrompt: 'cute, neon',
      rationale: 'pushed mood toward grim',
    };
    expect(extractRefinementJson(JSON.stringify(obj))).toEqual(obj);
  });

  it('strips ```json fences', () => {
    const fenced = '```json\n{"starterPrompt":"x","stylePrompt":"y","negativePrompt":""}\n```';
    expect(extractRefinementJson(fenced)).toMatchObject({ starterPrompt: 'x', stylePrompt: 'y' });
  });

  it('skips preamble before the JSON', () => {
    const raw = 'Here is the refinement:\n{"starterPrompt":"x","stylePrompt":"y"}\nend';
    expect(extractRefinementJson(raw)).toMatchObject({ starterPrompt: 'x' });
  });

  it('skips a schema-example block that has a <…> placeholder starterPrompt and parses the real block (Codex CLI prompt echo)', () => {
    const raw = [
      'codex banner',
      // The prompt template body — its first balanced { ... } block contains
      // <…> placeholders that walked past extractRefinementJson by mistake
      // would surface as "AI returned schema placeholder" instead of finding
      // the real response below it.
      '{"starterPrompt":"<full rewritten…>","stylePrompt":"<…>","negativePrompt":"<…>"}',
      'codex response:',
      '{"starterPrompt":"a darker world","stylePrompt":"gritty","negativePrompt":""}',
    ].join('\n');
    const out = extractRefinementJson(raw);
    expect(out.starterPrompt).toBe('a darker world');
    expect(out.stylePrompt).toBe('gritty');
  });

  it('throws when ONLY schema-placeholder blocks are present', () => {
    const raw = '{"starterPrompt":"<placeholder>","stylePrompt":"<x>"}';
    expect(() => extractRefinementJson(raw)).toThrow(/schema placeholder/);
  });

  it('throws on empty / non-string input', () => {
    expect(() => extractRefinementJson('')).toThrow(/Empty AI response/);
    expect(() => extractRefinementJson(null)).toThrow(/Empty AI response/);
  });

  it('throws when no balanced JSON object with starterPrompt is present', () => {
    expect(() => extractRefinementJson('just prose, no json')).toThrow(/Invalid JSON/);
    expect(() => extractRefinementJson('{"prompt":"unrelated shape"}')).toThrow(/Invalid JSON/);
  });
});

describe('worldBuilderRefine.buildWorldRefinePrompt', () => {
  it('includes all three originals + feedback verbatim', () => {
    const out = buildWorldRefinePrompt({
      starterPrompt: 'moebius scavengers',
      stylePrompt: 'comic ink, dust palette',
      negativePrompt: 'lowres',
      feedback: 'lean grimmer and more spiritual',
    });
    expect(out).toContain('moebius scavengers');
    expect(out).toContain('comic ink, dust palette');
    expect(out).toContain('lowres');
    expect(out).toContain('lean grimmer and more spiritual');
    // Schema must mention the three output keys so the LLM can comply.
    expect(out).toContain('"starterPrompt"');
    expect(out).toContain('"stylePrompt"');
    expect(out).toContain('"negativePrompt"');
  });

  it('substitutes (empty) for missing originals so the LLM sees the slot', () => {
    const out = buildWorldRefinePrompt({
      starterPrompt: 'seed',
      stylePrompt: '',
      negativePrompt: '',
      feedback: 'go dark',
    });
    expect(out).toMatch(/ORIGINAL STYLE PROMPT:\n\(empty\)/);
    expect(out).toMatch(/ORIGINAL NEGATIVE PROMPT:\n\(empty\)/);
  });
});
