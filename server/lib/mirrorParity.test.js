import { describe, it, expect } from 'vitest';
import {
  stripCommentsAndNormalize,
  extractDeclaration,
  compareDeclaration,
  compareRegexDeclaration,
  regexAlternationSource,
} from './mirrorParity.js';

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

describe('compareRegexDeclaration', () => {
  // The shape this exists for: the server spells a capability regex as an array
  // of per-alternative strings (so each alternative can carry its own comment)
  // while the browser copy inlines the same pattern as one literal.
  const server = "const TOOL_USE_RE = new RegExp([\n  'qwen',\n  'llama-?3\\\\.[1-9]',\n].join('|'), 'i');\n";
  const client = "export const isToolUseModel = (id) =>\n  /qwen|llama-?3\\.[1-9]/i.test(id);\n";

  it('matches the array form against the inline literal it compiles to', () => {
    const { serverSource, match } = compareRegexDeclaration(server, client, 'TOOL_USE_RE', 'isToolUseModel');
    expect(serverSource).toBe('qwen|llama-?3\\.[1-9]');
    expect(match).toBe(true);
  });

  it('reports a mismatch when one side gains an alternative', () => {
    const drifted = "export const isToolUseModel = (id) =>\n  /qwen|llama-?3\\.[1-9]|newfamily/i.test(id);\n";
    expect(compareRegexDeclaration(server, drifted, 'TOOL_USE_RE', 'isToolUseModel').match).toBe(false);
  });

  it('treats an escaped and a bare slash as the same pattern', () => {
    // `[-_/:]` is legal bare inside a character class and must be escaped
    // outside one; that typesetting difference is not a divergence.
    const bare = 'const RE = /a[-_/:]b/i;\n';
    const escaped = 'const RE = /a[-_\\/:]b/i;\n';
    expect(compareRegexDeclaration(bare, escaped, 'RE').match).toBe(true);
  });

  it('does not report a match when a side is missing or is not a regex', () => {
    expect(compareRegexDeclaration(server, 'const other = 1;', 'TOOL_USE_RE').match).toBe(false);
    expect(compareRegexDeclaration(server, 'const TOOL_USE_RE = 42;', 'TOOL_USE_RE').match).toBe(false);
  });
});

describe('regexAlternationSource fails closed', () => {
  // A scan-for-literals pass would silently DROP the non-literal element and
  // report the surviving alternatives as the whole pattern — a mirror that has
  // genuinely diverged then compares equal. Refuse the array instead.
  it('refuses an array holding anything but string literals', () => {
    expect(regexAlternationSource("const RE = new RegExp(['a', 'b'].join('|'), 'i');")).toBe('a|b');
    expect(regexAlternationSource("const RE = new RegExp(['a', SHARED].join('|'), 'i');")).toBeNull();
    expect(regexAlternationSource("const RE = new RegExp([...SHARED, 'b'].join('|'), 'i');")).toBeNull();
  });

  // `'\\x2e'` is the single character `.`, which matches ANYTHING — copying the
  // escape through as the text `x2e` would compare equal to a client `/x2e/i`
  // that means something entirely different.
  it('refuses an escape it cannot decode by inspection', () => {
    expect(regexAlternationSource("const RE = new RegExp(['a\\\\.b'].join('|'), 'i');")).toBe('a\\.b');
    expect(regexAlternationSource("const RE = new RegExp(['\\x2e'].join('|'), 'i');")).toBeNull();
    expect(regexAlternationSource("const RE = new RegExp(['\\n'].join('|'), 'i');")).toBeNull();
  });

  // A search-anywhere read would find the array and report the mirror intact
  // while the declaration assigns something else entirely.
  it('refuses a declaration that merely CONTAINS a recognizable form', () => {
    const array = "new RegExp(['a', 'b'].join('|'), 'i')";
    expect(regexAlternationSource(`const RE = ${array};`)).toBe('a|b');
    expect(regexAlternationSource(`const RE = FLAG ? ${array} : OTHER_RE;`)).toBeNull();
    expect(regexAlternationSource(`const RE = widen(${array});`)).toBeNull();
  });

  it('returns null for a declaration that is neither supported form', () => {
    expect(regexAlternationSource(null)).toBeNull();
    expect(regexAlternationSource('const RE = buildPattern();')).toBeNull();
  });
});
