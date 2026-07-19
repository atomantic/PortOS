import { describe, it, expect } from 'vitest';
import { stripCommentsAndNormalize, extractDeclaration, compareDeclaration } from './mirrorParity.js';

describe('stripCommentsAndNormalize', () => {
  it('drops block and line comments and collapses whitespace', () => {
    const src = `
      /* header */
      const A = 1; // trailing
    `;
    expect(stripCommentsAndNormalize(src)).toBe('const A = 1;');
  });

  it('lets the two sides differ in commentary while comparing equal', () => {
    expect(stripCommentsAndNormalize('// server note\nconst A = 1;'))
      .toBe(stripCommentsAndNormalize('/* client note */\nconst A = 1;'));
  });
});

describe('extractDeclaration', () => {
  // The regression this helper's own test exists for: a naive "return at the
  // first depth-0" walk stops at the closing paren of the PARAMETER LIST, so
  // the body never reaches the parity diff and a gutted mirror passes green.
  it('includes a function BODY, not just its signature', () => {
    const src = 'export function f(a) {\n  return a + 1;\n}\n';
    const out = extractDeclaration(src, 'f');
    expect(out).toContain('return a + 1;');
    expect(out.endsWith('}')).toBe(true);
  });

  it('includes the whole regex literal, not just up to a group\'s close paren', () => {
    const src = 'const RE = /(?:a|b):\\/\\/|\\bx::/i;\n';
    const out = extractDeclaration(src, 'RE');
    expect(out).toContain('\\bx::');
    expect(out.endsWith(';')).toBe(true);
  });

  it('handles async functions', () => {
    const src = 'export async function g(a) {\n  await a;\n}\n';
    expect(extractDeclaration(src, 'g')).toContain('await a;');
  });

  it('handles a function whose params contain a nested call/default', () => {
    const src = 'function h(a = fn(1), { b } = {}) {\n  return [a, b];\n}\n';
    expect(extractDeclaration(src, 'h')).toContain('return [a, b];');
  });

  it('handles array, Object.freeze and arrow-function const initializers', () => {
    expect(extractDeclaration('const A = [1, [2, 3]];\n', 'A')).toBe('const A = [1, [2, 3]];');
    expect(extractDeclaration('const S = Object.freeze({ a: { b: 1 } });\n', 'S'))
      .toBe('const S = Object.freeze({ a: { b: 1 } });');
    expect(extractDeclaration('const m = (p) => `${p}${x()}`;\n', 'm'))
      .toBe('const m = (p) => `${p}${x()}`;');
  });

  it('does not stop at a `;` nested inside the initializer', () => {
    const src = 'const F = (a) => { const b = a; return b; };\n';
    expect(extractDeclaration(src, 'F')).toBe('const F = (a) => { const b = a; return b; };');
  });

  it('returns null for an absent name', () => {
    expect(extractDeclaration('const A = 1;', 'B')).toBeNull();
  });

  it('returns null rather than a truncated slice when the source is unbalanced', () => {
    expect(extractDeclaration('function f(a) {\n  return a;\n', 'f')).toBeNull();
    expect(extractDeclaration('const A = [1, 2\n', 'A')).toBeNull();
  });
});

describe('compareDeclaration', () => {
  const server = 'export function f(a) {\n  return a + 1;\n}\n';

  it('matches when only commentary differs', () => {
    const client = '// mirrored from the server\nexport function f(a) {\n  /* same */ return a + 1;\n}\n';
    expect(compareDeclaration(server, client, 'f').match).toBe(true);
  });

  it('reports a mismatch when only the BODY diverges (signature identical)', () => {
    // The exact drift the signature-only walk used to miss.
    const gutted = 'export function f(a) {\n  return 0;\n}\n';
    expect(compareDeclaration(server, gutted, 'f').match).toBe(false);
  });

  it('reports a mismatch when a regex tail diverges', () => {
    const a = 'const RE = /(?:x|y):\\/\\//i;\n';
    const b = 'const RE = /(?:x|y):TOTALLY-DIFFERENT/i;\n';
    expect(compareDeclaration(a, b, 'RE').match).toBe(false);
  });

  it('does not report a match when the declaration is missing from a side', () => {
    const { clientDecl, match } = compareDeclaration(server, 'const other = 1;', 'f');
    expect(clientDecl).toBeNull();
    expect(match).toBe(false);
  });
});
