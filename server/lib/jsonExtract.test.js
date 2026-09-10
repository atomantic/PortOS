import { extractNonPlaceholderJson } from "./jsonExtract.js";
import { describe, it, expect } from 'vitest';
import { findAllBalancedBlocks, findBalancedBlocks, tryParseWithRepair, extractJson } from './jsonExtract.js';
import { BRAIN_DIGEST_ECHO_FIXTURE } from '../test/fixtures/brainDigestEcho.js';

describe('jsonExtract.findBalancedBlocks', () => {
  it('returns the single top-level brace-balanced block', () => {
    expect(findBalancedBlocks('{"a":1}')).toEqual(['{"a":1}']);
  });

  it('returns multiple sibling blocks in source order', () => {
    expect(findBalancedBlocks('{"a":1} prose {"b":2}')).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('respects quoted strings — braces inside JSON string values do not affect depth', () => {
    expect(findBalancedBlocks('{"a":"}"}')).toEqual(['{"a":"}"}']);
    expect(findBalancedBlocks('{"a":"{ nested }"}')).toEqual(['{"a":"{ nested }"}']);
  });

  it('honors escaped quotes inside JSON string values', () => {
    expect(findBalancedBlocks('{"a":"\\"}"}')).toEqual(['{"a":"\\"}"}']);
  });

  it('bails on unbalanced input — no fake completion of dangling braces', () => {
    expect(findBalancedBlocks('{"a":1')).toEqual([]);
  });

  it('returns an empty array for empty / non-string input', () => {
    expect(findBalancedBlocks('')).toEqual([]);
    expect(findBalancedBlocks(null)).toEqual([]);
    expect(findBalancedBlocks(undefined)).toEqual([]);
  });

  it('supports array-mode block walking', () => {
    expect(findBalancedBlocks('prose [1,2,3] more', { startChar: '[', endChar: ']' })).toEqual(['[1,2,3]']);
  });
});

describe('jsonExtract.tryParseWithRepair', () => {
  it('parses clean JSON in the happy path', () => {
    expect(tryParseWithRepair('{"a":1}')).toEqual({ value: { a: 1 } });
  });

  it('repairs trailing commas before `}` and `]`', () => {
    expect(tryParseWithRepair('{"a":[1,2,],"b":1,}')).toEqual({ value: { a: [1, 2], b: 1 } });
  });

  it('preserves trailing-comma-like patterns INSIDE string values (string-aware repair)', () => {
    // Without string-aware repair, `,}` inside a string value would be
    // rewritten to `}`, corrupting the content. The repair only runs
    // outside quoted string regions.
    const input = '{"label":"hello ,}","b":1,}'; // trailing `,}` outside, `,}` inside string
    expect(tryParseWithRepair(input)).toEqual({ value: { label: 'hello ,}', b: 1 } });
  });

  it('preserves `}}]` INSIDE string values (string-aware orphan-brace repair)', () => {
    // The Codex orphan-brace repair `}}]` → `}]}` must not touch
    // string contents — a model writing about JSON syntax in a label
    // would otherwise be silently rewritten.
    const input = '{"note":"the pattern }}] is a code smell","ok":true}';
    expect(tryParseWithRepair(input)).toEqual({
      value: { note: 'the pattern }}] is a code smell', ok: true },
    });
  });

  it('preserves `[...]` placeholder-looking content INSIDE string values', () => {
    // A string containing the literal text `[...]` (e.g. a translation
    // note or instruction text) must not be replaced with `[]`.
    const input = '{"hint":"insert [...] here"}';
    expect(tryParseWithRepair(input)).toEqual({ value: { hint: 'insert [...] here' } });
  });

  it('repairs Codex `}}]` orphan-brace corruption on a brace-balanced slice', () => {
    // In production this repair runs AFTER findBalancedBlocks has carved
    // out the outer-balanced slice. The slice contains `}}]` mid-content
    // (the variation object closed, an orphan `}` snuck in, then `]`
    // closes the array). Swapping `}}]` → `}]}` is brace-count-neutral
    // so the outer container still closes. The slice itself MUST be
    // brace-balanced (4 `{`, 4 `}`) — that's the post-findBalancedBlocks
    // shape, lifted from universeBuilderExpand's real production failure.
    const bad = '{"stylePrompt":"x","categories":{"vehicles":{"variations":[{"label":"a","prompt":"…blister"}}]}}';
    expect(tryParseWithRepair(bad)).toEqual({
      value: {
        stylePrompt: 'x',
        categories: { vehicles: { variations: [{ label: 'a', prompt: '…blister' }] } },
      },
    });
  });

  it('replaces literal `[...]` placeholder elisions with empty arrays', () => {
    expect(tryParseWithRepair('{"vars":[...]}')).toEqual({ value: { vars: [] } });
  });

  it('repairs a complete JSON document whose remaining tail was serialized as escaped text', () => {
    const bad = [
      '{',
      '  "items": [',
      '    { "name": "Alpha", "notes": ["kept"]\\n    },\\n    {\\n      \\"name\\": \\"Beta\\",\\n      \\"notes\\": [\\"also kept\\"]\\n    }\\n  ]\\n}',
    ].join('\n');
    expect(tryParseWithRepair(bad)).toEqual({
      value: {
        items: [
          { name: 'Alpha', notes: ['kept'] },
          { name: 'Beta', notes: ['also kept'] },
        ],
      },
    });
  });

  it('escapes unescaped quotation marks inside a prose string value', () => {
    const bad = '{"voice":"She calls it "the old rule" before rejecting it.","ok":true}';
    expect(tryParseWithRepair(bad)).toEqual({
      value: { voice: 'She calls it "the old rule" before rejecting it.', ok: true },
    });
  });

  it('closes a prose string whose final quote is missing before its structural close line', () => {
    const bad = '{\n  "dimensions": {\n    "world": {\n      "score": 8,\n      "fix": "Make each culture arise from its own history.\n    },\n    "craft": { "score": 7 }\n  }\n}';
    expect(tryParseWithRepair(bad)).toEqual({
      value: {
        dimensions: {
          world: { score: 8, fix: 'Make each culture arise from its own history.' },
          craft: { score: 7 },
        },
      },
    });
  });

  it('preserves an ordinary raw multiline string for the control-character repair', () => {
    const bad = '{"body":"line one\nline two","ok":true}';
    expect(tryParseWithRepair(bad)).toEqual({
      value: { body: 'line one\nline two', ok: true },
    });
  });

  it('combines serialized-tail and bare-quote repairs in one completed response', () => {
    const bad = '{"items":[{"voice":"plain"}\\n, {\\n  \\"voice\\": \\"Calls it \\"witness\\" before answering.\\"\\n}\\n]}';
    expect(tryParseWithRepair(bad)).toEqual({
      value: { items: [{ voice: 'plain' }, { voice: 'Calls it "witness" before answering.' }] },
    });
  });

  it('does not guess at an invalid backslash tail that is not a serialized JSON fragment', () => {
    const bad = '{"items":[]}\\not-json';
    expect(tryParseWithRepair(bad).error).toBeInstanceOf(Error);
  });

  it('escapes raw control chars (literal newlines/tabs) inside a string value', () => {
    // A model writes a multi-line markdown field with literal newlines/tabs
    // instead of the `\n`/`\t` escapes JSON requires — JSON.parse throws
    // "Bad control character". The repair escapes only inside-string controls.
    const bad = '{"body":"line one\nline two\ttabbed","ok":true}';
    expect(tryParseWithRepair(bad)).toEqual({
      value: { body: 'line one\nline two\ttabbed', ok: true },
    });
  });

  it('escapes a raw control char even when a backslash immediately precedes it', () => {
    // A dangling backslash followed by a literal newline (double corruption:
    // an invalid \-escape AND a raw control char). The control char must still
    // be escaped so the block parses, rather than being copied through as an
    // "escaped" char. `\\` + raw LF → parseable `\\` + `\n`.
    const bad = '{"body":"line\\\nnext"}';
    const r = tryParseWithRepair(bad);
    expect(r.error).toBeUndefined();
    expect(typeof r.value.body).toBe('string');
  });

  it('leaves structural whitespace + already-escaped sequences untouched while escaping a raw control char', () => {
    // Force the repair to actually run: one string has a RAW newline (invalid),
    // while the object also has structural inter-token newlines and another
    // string with an already-escaped `\n`. The repair must escape only the raw
    // one and leave the structural whitespace and pre-escaped sequence intact.
    const bad = '{\n  "a": "raw\nnewline",\n  "b": "already \\n escaped"\n}';
    expect(tryParseWithRepair(bad)).toEqual({
      value: { a: 'raw\nnewline', b: 'already \n escaped' },
    });
  });

  it('returns the concrete parse error when no repair can recover the input', () => {
    const r1 = tryParseWithRepair('{ this is not valid json');
    expect(r1.value).toBeUndefined();
    expect(r1.error).toBeInstanceOf(Error);
    expect(r1.error.message).toMatch(/JSON/i);
    const r2 = tryParseWithRepair('garbage');
    expect(r2.error).toBeInstanceOf(Error);
  });

  it('returns an error for non-string input', () => {
    expect(tryParseWithRepair(null).error).toBeInstanceOf(Error);
    expect(tryParseWithRepair(42).error).toBeInstanceOf(Error);
  });

  it('preserves JSON `null` as a valid parsed value distinguishable from parse failure', () => {
    // A top-level JSON `null` literal is a valid parsed value — the
    // `{ value }` wrapper lets callers distinguish it from a parse
    // failure (which returns `{ error }`).
    expect(tryParseWithRepair('null')).toEqual({ value: null });
  });
});

describe('jsonExtract.extractJson', () => {
  it('parses raw JSON object', () => {
    expect(extractJson('{"a":1}').value).toEqual({ a: 1 });
  });

  it('strips ```json fences', () => {
    expect(extractJson('```json\n{"a":1}\n```').value).toEqual({ a: 1 });
  });

  it('strips bare ``` fences', () => {
    expect(extractJson('```\n{"a":1}\n```').value).toEqual({ a: 1 });
  });

  it('skips a preamble before the first { … } block (CLI banner)', () => {
    const raw = 'OpenAI Codex CLI v2.1.0\n[workdir, /tmp]\n\n{"a":1,"b":2}\n[finished]';
    expect(extractJson(raw).value).toEqual({ a: 1, b: 2 });
  });

  it('returns the first matching block when no shape predicate is supplied', () => {
    expect(extractJson('{"a":1} {"b":2}').value).toEqual({ a: 1 });
  });

  it('skips a pseudo-JSON schema example and picks the real response via shapePredicate', () => {
    // Codex echoes the prompt's schema-shaped example back to stdout
    // before the model response. extractJson must skip it and find the
    // real expansion-shaped block.
    const raw = [
      '{ "label": "Crystalline canyon basin", "prompt": "vast crystalline canyon" }',
      '{"stylePrompt":"painterly","categories":{"landscapes":{"variations":[]}}}',
    ].join('\n');
    const isExpansion = (o) => o && typeof o === 'object'
      && (typeof o.stylePrompt === 'string' || typeof o.negativePrompt === 'string');
    const { value } = extractJson(raw, { shapePredicate: isExpansion });
    expect(value.stylePrompt).toBe('painterly');
  });

  it('skips a fenced echoed schema before the real caller response', () => {
    const { value } = extractJson(BRAIN_DIGEST_ECHO_FIXTURE.raw, {
      skipInnerFence: true,
      shapePredicate: (candidate) => candidate && typeof candidate === 'object'
        && Array.isArray(candidate.topActions),
    });
    expect(value).toEqual(BRAIN_DIGEST_ECHO_FIXTURE.actual);
  });

  it('falls back to the first parseable block when shapePredicate matches nothing', () => {
    // If the predicate is too strict to match anything, the first valid
    // block is still returned so callers can decide whether to accept
    // the looser shape or fail with a typed error.
    const raw = '{"a":1} {"b":2}';
    const { value } = extractJson(raw, { shapePredicate: () => false });
    expect(value).toEqual({ a: 1 });
  });

  it('replaces literal [...] placeholders with empty arrays so the rest parses', () => {
    const raw = '{"stylePrompt":"x","categories":{"vehicles":{"variations":[...]}}}';
    const { value } = extractJson(raw);
    expect(value.stylePrompt).toBe('x');
    expect(value.categories.vehicles.variations).toEqual([]);
  });

  it('strips trailing comma before `]`', () => {
    const raw = '{"variations":[{"label":"a","prompt":"b"},]}';
    const { value } = extractJson(raw);
    expect(value.variations).toEqual([{ label: 'a', prompt: 'b' }]);
  });

  it('repairs Codex CLI orphan-brace corruption (`}}]` → `}]}`) inside the response', () => {
    const bad = '{"stylePrompt":"x","categories":{"vehicles":{"variations":[{"label":"a","prompt":"…blister"}}]}}}';
    const { value } = extractJson(bad);
    expect(value.stylePrompt).toBe('x');
    expect(value.categories.vehicles.variations).toEqual([{ label: 'a', prompt: '…blister' }]);
  });

  it('returns lastError + lastPreview when no block parses', () => {
    const { value, lastError, lastPreview } = extractJson('{ "broken');
    expect(value).toBeUndefined();
    expect(lastError).toBeInstanceOf(Error);
    expect(lastPreview).toContain('broken');
  });

  it('surfaces the concrete JSON.parse error message (not a generic "no JSON block found")', () => {
    // Regression: when every candidate block fails parsing, `lastError`
    // must carry the actual JSON.parse exception so downstream error
    // context (e.g. ServerError reason) is informative.
    const { value, lastError } = extractJson('{ "invalid": }');
    expect(value).toBeUndefined();
    // V8 / SpiderMonkey error messages differ but both reference JSON
    // and contain a position marker. The important thing is that it's
    // NOT the generic fallback message.
    expect(lastError.message).not.toMatch(/No matching JSON block found/);
    expect(lastError.message).toMatch(/JSON|Unexpected|token/i);
  });

  it('successfully extracts a top-level JSON `null` literal', () => {
    // A bare `null` response is a valid JSON value — extractJson must
    // not collapse it into a "did not parse" sentinel. Bracket-aware
    // findBalancedBlocks won't find a block for `null` (no `{`/`[`),
    // so the fallback `candidates.push(s)` path handles it.
    expect(extractJson('null')).toEqual({ value: null });
  });

  it('returns an Empty-LLM-response sentinel for empty input', () => {
    const { value, lastError } = extractJson('');
    expect(value).toBeUndefined();
    expect(lastError.message).toMatch(/Empty LLM response/);
  });

  it('walks arrays when blockType is array', () => {
    const raw = 'preamble [1,2,3] postamble';
    expect(extractJson(raw, { blockType: 'array' }).value).toEqual([1, 2, 3]);
  });

  it('does not misparse `}` inside string values (string-aware brace walker)', () => {
    const raw = 'banner {"a":"close-brace-} inside"}';
    expect(extractJson(raw).value).toEqual({ a: 'close-brace-} inside' });
  });
});

describe('findAllBalancedBlocks', () => {
  it('returns nested blocks in closing order, so a reverse walk sees the outer object first', () => {
    const blocks = findAllBalancedBlocks('{"a":{"b":1}}');
    expect(blocks).toEqual(['{"b":1}', '{"a":{"b":1}}']);
  });

  it('keeps scanning past an unmatched opening brace (findBalancedBlocks bails there)', () => {
    const noisy = 'repaint fragment { then the answer {"a":1}';
    expect(findBalancedBlocks(noisy)).toEqual([]);
    expect(findAllBalancedBlocks(noisy)).toEqual(['{"a":1}']);
  });

  it('ignores an unmatched closing brace', () => {
    expect(findAllBalancedBlocks('} {"a":1} }')).toEqual(['{"a":1}']);
  });

  it('is string-aware, so braces inside string values do not shift the depth', () => {
    expect(findAllBalancedBlocks('{"a":"{ not a brace \\" }"}')).toEqual(['{"a":"{ not a brace \\" }"}']);
  });

  it('does not let a stray quote on one line swallow the JSON on the next', () => {
    // A truncated PTY redraw leaves an unmatched `"`; without the line-break
    // reset the walker would treat the rest of the transcript as string content.
    const transcript = '\u2502 renaming "foo to bar\n{"a":1}\n';
    expect(findAllBalancedBlocks(transcript)).toEqual(['{"a":1}']);
  });

  it('returns [] for non-string or empty input', () => {
    expect(findAllBalancedBlocks(null)).toEqual([]);
    expect(findAllBalancedBlocks('')).toEqual([]);
  });
});

describe("extractNonPlaceholderJson", () => {
  const extractRefinementJson = (raw) => extractNonPlaceholderJson(raw, { field: "starterPrompt" });
  it("parses a raw refinement object", () => {
    const obj = {
      starterPrompt: "a darker scavenger universe",
      stylePrompt: "gritty palette, deep shadows",
      negativePrompt: "cute, neon",
      rationale: "pushed mood toward grim",
    };
    expect(extractRefinementJson(JSON.stringify(obj))).toEqual(obj);
  });

  it("strips ```json fences", () => {
    const fenced =
      '```json\n{"starterPrompt":"x","stylePrompt":"y","negativePrompt":""}\n```';
    expect(extractRefinementJson(fenced)).toMatchObject({
      starterPrompt: "x",
      stylePrompt: "y",
    });
  });

  it("skips preamble before the JSON", () => {
    const raw =
      'Here is the refinement:\n{"starterPrompt":"x","stylePrompt":"y"}\nend';
    expect(extractRefinementJson(raw)).toMatchObject({ starterPrompt: "x" });
  });

  it("skips a schema-example block that has a <…> placeholder starterPrompt and parses the real block (Codex CLI prompt echo)", () => {
    const raw = [
      "codex banner",
      // The prompt template body — its first balanced { ... } block contains
      // <…> placeholders that walked past extractRefinementJson by mistake
      // would surface as "AI returned schema placeholder" instead of finding
      // the real response below it.
      '{"starterPrompt":"<full rewritten…>","stylePrompt":"<…>","negativePrompt":"<…>"}',
      "codex response:",
      '{"starterPrompt":"a darker universe","stylePrompt":"gritty","negativePrompt":""}',
    ].join("\n");
    const out = extractRefinementJson(raw);
    expect(out.starterPrompt).toBe("a darker universe");
    expect(out.stylePrompt).toBe("gritty");
  });

  it("throws when ONLY schema-placeholder blocks are present", () => {
    const raw = '{"starterPrompt":"<placeholder>","stylePrompt":"<x>"}';
    expect(() => extractRefinementJson(raw)).toThrow(/schema placeholder/);
  });

  it("throws on empty / non-string input", () => {
    expect(() => extractRefinementJson("")).toThrow(/Empty AI response/);
    expect(() => extractRefinementJson(null)).toThrow(/Empty AI response/);
  });

  it("throws when no balanced JSON object with starterPrompt is present", () => {
    expect(() => extractRefinementJson("just prose, no json")).toThrow(
      /Invalid JSON/,
    );
    expect(() => extractRefinementJson('{"prompt":"unrelated shape"}')).toThrow(
      /Invalid JSON/,
    );
  });
});
