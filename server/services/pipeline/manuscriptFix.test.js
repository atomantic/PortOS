import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { locateFindSpan, normalizeFix, PROMPT_EXAMPLE_PLACEHOLDERS } from './manuscriptFix.js';

describe('locateFindSpan', () => {
  it('locates an exact substring', () => {
    const text = 'PAGE 56\nPANEL 1\nGiant stands.';
    expect(locateFindSpan(text, 'PANEL 1\nGiant')).toEqual({ start: 8, end: 8 + 'PANEL 1\nGiant'.length });
  });

  it('tolerates whitespace-only differences in the quote (LLM reformatting)', () => {
    // The manuscript has a single newline; the quoted `find` added a blank line.
    const text = 'PAGE 56\nPANEL 1\nLow angle. Giant stands.\nPANEL 2\nHe falls.';
    const find = 'PAGE 56\n\nPANEL 1\nLow angle. Giant stands.';
    const span = locateFindSpan(text, find);
    expect(span).not.toBeNull();
    // The matched span covers the ORIGINAL (single-newline) text, not find.length.
    expect(text.slice(span.start, span.end)).toBe('PAGE 56\nPANEL 1\nLow angle. Giant stands.');
    expect(span.end - span.start).toBe(find.length - 1);
  });

  it('returns null when the text is genuinely absent', () => {
    expect(locateFindSpan('hello world', 'not here at all')).toBeNull();
  });

  it('returns null for an empty find', () => {
    expect(locateFindSpan('anything', '')).toBeNull();
  });

  it('prefers an exact match over a fuzzy one when both exist', () => {
    // "run away." matches exactly at index 0; the second occurrence only matches
    // via whitespace tolerance (tab). Exact wins regardless of the anchor.
    const text = 'run away.\n\n[marker] run\taway.';
    expect(locateFindSpan(text, 'run away.', '[marker]').start).toBe(0);
  });

  it('disambiguates between two fuzzy-only matches by the nearest anchorQuote', () => {
    // No exact match (find uses a space; both occurrences use a tab), so both
    // resolve only via the whitespace-tolerant regex. The anchor sits beside the
    // SECOND occurrence, so that span is chosen.
    const text = 'run\taway. ... ... ... [marker] run\taway.';
    const span = locateFindSpan(text, 'run away.', '[marker]');
    const second = text.indexOf('run\taway.', 1);
    expect(span.start).toBe(second);
    expect(text.slice(span.start, span.end)).toBe('run\taway.');
  });

  it('escapes regex metacharacters in the quote', () => {
    const text = 'Cost is $5 (approx).';
    expect(locateFindSpan(text, '$5 (approx)')).toEqual({ start: 8, end: 8 + '$5 (approx)'.length });
  });
});

describe('normalizeFix — echoed-placeholder guard', () => {
  // One target section whose content is real manuscript text.
  const targets = [{ issueId: 'issue-1', stageId: 'pipeline-script', number: 1, title: '', content: 'PAGE 1\nPANEL 1\nJack climbs.' }];

  const realEdit = { issueNumber: 1, find: 'Jack climbs.', replace: 'Jack climbs, breathless.' };

  it('produces a usable fix for a real find/replace', () => {
    const fix = normalizeFix({ edits: [realEdit] }, targets);
    expect(fix).not.toBeNull();
    expect(fix.find).toBe('Jack climbs.');
    expect(fix.replace).toBe('Jack climbs, breathless.');
    expect(fix.fuzzy).toBeUndefined();
  });

  it('drops an edit that echoes the current bracketed placeholders → null fix', () => {
    const fix = normalizeFix({
      edits: [{
        issueNumber: 1,
        find: '<paste the verbatim manuscript span you are replacing>',
        replace: '<that same span, rewritten to close the gap>',
        note: '<optional short note explaining this edit>',
      }],
    }, targets);
    expect(fix).toBeNull();
  });

  it('drops an edit that echoes the prior prose-style placeholders (un-migrated install)', () => {
    const fix = normalizeFix({
      edits: [{
        issueNumber: 1,
        find: "a verbatim excerpt copied EXACTLY from that issue's manuscript above — the span you are replacing",
        replace: 'that same span rewritten to close the gap',
      }],
    }, targets);
    expect(fix).toBeNull();
  });

  it('keeps the real edits when a response mixes a real edit with an echoed one', () => {
    const fix = normalizeFix({
      edits: [
        { issueNumber: 1, find: '<that same span, rewritten to close the gap>', replace: '<that same span, rewritten to close the gap>' },
        realEdit,
      ],
    }, targets);
    expect(fix).not.toBeNull();
    expect(fix.edits).toHaveLength(1);
    expect(fix.edits[0].find).toBe('Jack climbs.');
  });

  it('pins the bracketed placeholders to the live prompt example (drift catch)', () => {
    // The guard hardcodes the prompt's example values; if the prompt example's
    // find/replace wording changes without updating PROMPT_EXAMPLE_PLACEHOLDERS,
    // a fresh echo would slip through. Assert the current bracketed strings still
    // appear verbatim in the shipped prompt so that coupling can't silently rot.
    const promptPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '../../../data.reference/prompts/stages/pipeline-manuscript-fix.md',
    );
    const prompt = readFileSync(promptPath, 'utf-8');
    const bracketed = [...PROMPT_EXAMPLE_PLACEHOLDERS].filter((s) => s.startsWith('<'));
    expect(bracketed.length).toBeGreaterThan(0);
    for (const placeholder of bracketed) {
      expect(prompt).toContain(placeholder);
    }
  });
});
