import { describe, expect, it } from 'vitest';
import { lintSkill, SKILL_LINT_LIMITS } from './skillLinter.js';

const codes = (input) => lintSkill(input).map((warning) => warning.code);

describe('lintSkill', () => {
  it('passes a compact, described skill', () => {
    expect(lintSkill({ content: '# Deploy\n\n1. Build\n2. Ship', frontmatter: { description: 'Deploy to staging' } })).toEqual([]);
  });

  it('flags a missing or over-long description', () => {
    expect(codes({ content: 'x', frontmatter: {} })).toEqual(['missing-description']);
    expect(codes({ content: 'x', frontmatter: { description: 'd'.repeat(121) } })).toEqual(['long-description']);
  });

  it('flags an oversized body', () => {
    expect(codes({ content: 'a'.repeat(SKILL_LINT_LIMITS.MAX_BODY_CHARS + 1), frontmatter: { description: 'd' } })).toEqual(['oversized-body']);
  });

  it('flags dense incident narration but not one stray reference', () => {
    const diary = Array.from({ length: 8 }, (_, i) => `On 2026-07-0${i + 1} PR #${100 + i} broke it.`).join('\n');
    expect(codes({ content: diary, frontmatter: { description: 'd' } })).toEqual(['incident-log-shape']);
    const procedure = `${'Run the build and verify the output carefully. '.repeat(40)}See #1234.`;
    expect(codes({ content: procedure, frontmatter: { description: 'd' } })).toEqual([]);
  });

  it('flags reference sprawl', () => {
    expect(codes({ content: 'x', frontmatter: { description: 'd' }, referenceFileCount: 61 })).toEqual(['references-sprawl']);
    expect(codes({ content: 'x', frontmatter: { description: 'd' }, referenceFileCount: 60 })).toEqual([]);
  });
});
