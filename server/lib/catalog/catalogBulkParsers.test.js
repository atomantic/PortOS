/**
 * Boundary tests for the catalog bulk-import parsers. Pure — no DB, no LLM.
 *
 * Each parser is exercised on a happy-path payload + at least one structural
 * failure mode. Per-entry Zod validation happens at the route boundary; this
 * suite only asserts that the parser produces the normalized
 * `{ type, name, payload, tags }` shape (or throws on structurally invalid
 * input).
 */

import { describe, it, expect } from 'vitest';
import {
  parseJsonBulk,
  parseCsvBulk,
  parseMarkdownBulk,
  parseBulkPayload,
  PRIMARY_CONTENT_KEY_BY_TYPE,
  ingredientToMarkdown,
  bundleToMarkdown,
  toYamlString,
} from './catalogBulkParsers.js';

describe('PRIMARY_CONTENT_KEY_BY_TYPE', () => {
  it('mirrors the client-side map for the six v1 types', () => {
    expect(PRIMARY_CONTENT_KEY_BY_TYPE).toEqual({
      character: 'physicalDescription',
      place: 'description',
      object: 'description',
      idea: 'summary',
      scene: 'summary',
      concept: 'summary',
    });
  });
});

describe('parseJsonBulk', () => {
  it('parses an array of well-formed entries and lands description in the type primary key', () => {
    const out = parseJsonBulk(JSON.stringify([
      { type: 'character', name: 'Alice', description: 'a curious sleuth', tags: ['noir'] },
      { type: 'place', name: 'The Hollow', description: 'abandoned subway tunnel' },
    ]));
    expect(out).toEqual([
      { type: 'character', name: 'Alice', payload: { physicalDescription: 'a curious sleuth' }, tags: ['noir'] },
      { type: 'place', name: 'The Hollow', payload: { description: 'abandoned subway tunnel' }, tags: [] },
    ]);
  });

  it('preserves explicit payload keys over the description shortcut', () => {
    const out = parseJsonBulk(JSON.stringify([
      { type: 'character', name: 'Bob', description: 'shortcut', payload: { physicalDescription: 'explicit wins' } },
    ]));
    expect(out[0].payload.physicalDescription).toBe('explicit wins');
  });

  it('throws on non-array root', () => {
    expect(() => parseJsonBulk(JSON.stringify({ type: 'character', name: 'X' }))).toThrow(/array/);
  });

  it('throws on invalid JSON', () => {
    expect(() => parseJsonBulk('{not json}')).toThrow(/invalid JSON/);
  });

  it('throws on unknown ingredient type', () => {
    expect(() => parseJsonBulk(JSON.stringify([{ type: 'faction', name: 'X' }]))).toThrow(/invalid or missing type/);
  });

  it('throws on missing name', () => {
    expect(() => parseJsonBulk(JSON.stringify([{ type: 'idea', name: '   ' }]))).toThrow(/name is required/);
  });

  it('accepts an export-bundle wrapper with an ingredients array (round-trip)', () => {
    const bundle = JSON.stringify({
      version: 1,
      ref: { kind: 'universe', id: 'u1' },
      ingredients: [{ type: 'idea', name: 'X', payload: { summary: 'hi' } }],
    });
    const out = parseJsonBulk(bundle);
    expect(out).toEqual([{ type: 'idea', name: 'X', payload: { summary: 'hi' }, tags: [] }]);
  });

  it('rejects an object root without an ingredients array', () => {
    expect(() => parseJsonBulk(JSON.stringify({ version: 1, ref: { kind: 'universe', id: 'u1' } }))).toThrow(/array of entries or an export bundle/);
  });

  it('attaches a non-enumerable bundleRef when the root is an export bundle', () => {
    const out = parseJsonBulk(JSON.stringify({
      version: 1,
      ref: { kind: 'series', id: 'ser-9' },
      ingredients: [{ type: 'idea', name: 'X', payload: { summary: 'hi' } }],
    }));
    // Non-enumerable: deep-equal on the array shape is unaffected.
    expect(out).toEqual([{ type: 'idea', name: 'X', payload: { summary: 'hi' }, tags: [] }]);
    expect(Object.keys(out)).not.toContain('bundleRef');
    expect(out.bundleRef).toEqual({ kind: 'series', id: 'ser-9' });
  });

  it('coerces a numeric bundle ref id to a string', () => {
    const out = parseJsonBulk(JSON.stringify({
      version: 1,
      ref: { kind: 'issue', id: 42 },
      ingredients: [{ type: 'idea', name: 'X' }],
    }));
    expect(out.bundleRef).toEqual({ kind: 'issue', id: '42' });
  });

  it('leaves bundleRef undefined for a bare array (no bundle root)', () => {
    const out = parseJsonBulk(JSON.stringify([{ type: 'idea', name: 'X' }]));
    expect(out.bundleRef).toBeUndefined();
  });

  it('propagates per-row roleForExportedRef as a non-enumerable field', () => {
    const out = parseJsonBulk(JSON.stringify({
      version: 1,
      ref: { kind: 'universe', id: 'u1' },
      ingredients: [
        { type: 'character', name: 'Alice', payload: { physicalDescription: 'curious' }, roleForExportedRef: 'lead' },
        { type: 'idea', name: 'X', payload: { summary: 'hi' } },
      ],
    }));
    expect(out).toEqual([
      { type: 'character', name: 'Alice', payload: { physicalDescription: 'curious' }, tags: [] },
      { type: 'idea', name: 'X', payload: { summary: 'hi' }, tags: [] },
    ]);
    expect(out[0].roleForExportedRef).toBe('lead');
    expect(out[1].roleForExportedRef).toBeUndefined();
  });
});

describe('parseCsvBulk', () => {
  it('parses the documented header + data rows', () => {
    const csv = [
      'type,name,description,tags',
      'character,Alice,A curious sleuth,"noir, gritty"',
      'place,The Hollow,Abandoned subway tunnel,',
    ].join('\n');
    const out = parseCsvBulk(csv);
    expect(out).toEqual([
      { type: 'character', name: 'Alice', payload: { physicalDescription: 'A curious sleuth' }, tags: ['noir', 'gritty'] },
      { type: 'place', name: 'The Hollow', payload: { description: 'Abandoned subway tunnel' }, tags: [] },
    ]);
  });

  it('folds unknown columns into payload (canon shape pass-through)', () => {
    const csv = [
      'type,name,personality,role',
      'character,Alice,curious,detective',
    ].join('\n');
    const out = parseCsvBulk(csv);
    expect(out[0].payload).toEqual({ personality: 'curious', role: 'detective' });
  });

  it('handles quoted fields with embedded commas and escaped quotes', () => {
    const csv = [
      'type,name,description',
      'idea,X,"comma, inside and ""quotes"" too"',
    ].join('\n');
    const out = parseCsvBulk(csv);
    expect(out[0].payload.summary).toBe('comma, inside and "quotes" too');
  });

  it('throws when required headers are missing', () => {
    expect(() => parseCsvBulk('foo,bar\nx,y')).toThrow(/headers must include/);
  });

  it('throws when there is no data row', () => {
    expect(() => parseCsvBulk('type,name')).toThrow(/header row and at least one/);
  });

  it('skips blank lines between data rows', () => {
    const csv = ['type,name', 'idea,A', '', 'idea,B', ''].join('\n');
    const out = parseCsvBulk(csv);
    expect(out.map((e) => e.name)).toEqual(['A', 'B']);
  });
});

describe('parseMarkdownBulk', () => {
  it('parses sections, body, and tags', () => {
    const md = [
      '## Character: Alice',
      'A curious sleuth.',
      'She walks at night.',
      'tags: noir, gritty',
      '',
      '## Place: The Hollow',
      'Abandoned subway tunnel.',
    ].join('\n');
    const out = parseMarkdownBulk(md);
    expect(out).toEqual([
      {
        type: 'character',
        name: 'Alice',
        payload: { physicalDescription: 'A curious sleuth.\nShe walks at night.' },
        tags: ['noir', 'gritty'],
      },
      {
        type: 'place',
        name: 'The Hollow',
        payload: { description: 'Abandoned subway tunnel.' },
        tags: [],
      },
    ]);
  });

  it('ignores unrecognized type headings (drops their body)', () => {
    const md = [
      '## Faction: Goons',
      'a body we ignore',
      '## Scene: Rooftop chase',
      'jumped across two buildings',
    ].join('\n');
    const out = parseMarkdownBulk(md);
    expect(out).toEqual([
      { type: 'scene', name: 'Rooftop chase', payload: { summary: 'jumped across two buildings' }, tags: [] },
    ]);
  });

  it('throws when no `## <Type>: <Name>` section is found', () => {
    expect(() => parseMarkdownBulk('Just a paragraph.\nNo heading here.')).toThrow(/zero `## <Type>: <Name>`/);
  });

  it('handles CRLF line endings', () => {
    const md = '## Idea: X\r\ndescribed here\r\ntags: a, b\r\n';
    const out = parseMarkdownBulk(md);
    expect(out[0]).toEqual({ type: 'idea', name: 'X', payload: { summary: 'described here' }, tags: ['a', 'b'] });
  });

  it('is case-insensitive on the type token', () => {
    const md = '## CHARACTER: X\nbody\n';
    const out = parseMarkdownBulk(md);
    expect(out[0].type).toBe('character');
  });

  it('records a warning for each unknown type heading', () => {
    const md = '## Idea: keeper\nkept body\n## Faction: Goons\nfaction body\n## Plce: typo\nbad body\n## Place: keeper2\nplace body\n';
    const out = parseMarkdownBulk(md);
    expect(out.map((e) => e.name)).toEqual(['keeper', 'keeper2']);
    expect(out.warnings).toHaveLength(2);
    expect(out.warnings[0]).toMatch(/Unknown type "Faction"/);
    expect(out.warnings[1]).toMatch(/Unknown type "Plce"/);
  });

  it('exposes an empty warnings array when all headings are valid', () => {
    const out = parseMarkdownBulk('## Idea: X\nbody\n');
    expect(out.warnings).toEqual([]);
  });

  it('parses a ```json fence into payload.* instead of polluting the body', () => {
    const md = [
      '## Character: Alice',
      'a curious sleuth',
      '',
      '```json',
      '{',
      '  "personality": "quiet",',
      '  "role": "detective"',
      '}',
      '```',
      '',
    ].join('\n');
    const out = parseMarkdownBulk(md);
    expect(out[0]).toEqual({
      type: 'character',
      name: 'Alice',
      payload: { physicalDescription: 'a curious sleuth', personality: 'quiet', role: 'detective' },
      tags: [],
    });
  });

  it('parses a `### Scraps` subsection into a sibling scraps[] array (not the body)', () => {
    const md = [
      '## Idea: time loop',
      'recurs every Tuesday',
      '',
      '### Scraps',
      '',
      '- (paste) first sighting in chapter 1',
      '- (transcript) mentioned again at the diner',
      '',
    ].join('\n');
    const out = parseMarkdownBulk(md);
    expect(out[0].payload).toEqual({ summary: 'recurs every Tuesday' });
    expect(out[0].scraps).toEqual([
      { sourceKind: 'paste', rawText: 'first sighting in chapter 1' },
      { sourceKind: 'transcript', rawText: 'mentioned again at the diner' },
    ]);
  });

  it('records a warning and skips a malformed JSON fence without corrupting the body', () => {
    const md = [
      '## Idea: X',
      'good body',
      '',
      '```json',
      '{not valid json}',
      '```',
      '',
    ].join('\n');
    const out = parseMarkdownBulk(md);
    expect(out[0].payload).toEqual({ summary: 'good body' });
    expect(out.warnings.some((w) => /Malformed JSON fence/.test(w))).toBe(true);
  });

  it('losslessly round-trips a full export ingredient (body + fence + scraps)', () => {
    const ing = {
      type: 'character',
      name: 'Alice',
      payload: { physicalDescription: 'a curious sleuth', personality: 'quiet', role: 'detective' },
      tags: ['noir'],
      scraps: [{ sourceKind: 'paste', rawText: 'first sighting in chapter 1' }],
    };
    const md = ingredientToMarkdown(ing);
    const out = parseMarkdownBulk(md);
    // scraps ride NON-enumerable so the strict bulk-import gate
    // (catalogIngredientCreateSchema has no `scraps` field) accepts the
    // re-import; assert the enumerable shape and the scraps sibling separately.
    expect(out[0]).toEqual({
      type: 'character',
      name: 'Alice',
      payload: { physicalDescription: 'a curious sleuth', personality: 'quiet', role: 'detective' },
      tags: ['noir'],
    });
    expect(Object.keys(out[0])).not.toContain('scraps');
    expect(out[0].scraps).toEqual([{ sourceKind: 'paste', rawText: 'first sighting in chapter 1' }]);
  });

  it('leaves a non-JSON fence (```js/```text) intact in the body instead of dropping it', () => {
    const md = [
      '## Idea: snippet',
      'here is code:',
      '```js',
      'const x = 1;',
      '```',
      'after the fence',
      '',
    ].join('\n');
    const out = parseMarkdownBulk(md);
    expect(out[0].payload.summary).toContain('```js');
    expect(out[0].payload.summary).toContain('const x = 1;');
    expect(out[0].payload.summary).toContain('after the fence');
    expect(out.warnings).toEqual([]);
  });
});

describe('parseBulkPayload dispatch', () => {
  it('routes to the right parser by format name', () => {
    expect(parseBulkPayload('json', '[{"type":"idea","name":"X"}]')[0].name).toBe('X');
    expect(parseBulkPayload('csv', 'type,name\nidea,X')[0].name).toBe('X');
    expect(parseBulkPayload('markdown', '## Idea: X\nbody\n')[0].name).toBe('X');
  });

  it('throws on unknown format', () => {
    expect(() => parseBulkPayload('toml', 'x')).toThrow(/unknown bulk-import format/);
  });
});

describe('ingredientToMarkdown / bundleToMarkdown', () => {
  it('emits a Type: Name heading + body + tags + scraps', () => {
    const md = ingredientToMarkdown({
      type: 'character',
      name: 'Alice',
      payload: { physicalDescription: 'a curious sleuth', personality: 'quiet' },
      tags: ['noir'],
      scraps: [{ sourceKind: 'paste', rawText: 'first sighting in chapter 1' }],
    });
    expect(md).toContain('## Character: Alice');
    expect(md).toContain('a curious sleuth');
    expect(md).toContain('tags: noir');
    expect(md).toContain('"personality": "quiet"');
    expect(md).toContain('### Scraps');
    expect(md).toContain('first sighting in chapter 1');
  });

  it('round-trips type/name/body via the markdown parser', () => {
    const bundle = {
      ref: { kind: 'universe', id: 'u1' },
      exportedAt: '2026-05-29T00:00:00.000Z',
      ingredients: [
        { type: 'character', name: 'Alice', payload: { physicalDescription: 'curious' }, tags: ['noir'], scraps: [] },
        { type: 'idea', name: 'time loop', payload: { summary: 'recurs every Tuesday' }, tags: [], scraps: [] },
      ],
    };
    const md = bundleToMarkdown(bundle);
    const reparsed = parseMarkdownBulk(md);
    expect(reparsed).toEqual([
      { type: 'character', name: 'Alice', payload: { physicalDescription: 'curious' }, tags: ['noir'] },
      { type: 'idea', name: 'time loop', payload: { summary: 'recurs every Tuesday' }, tags: [] },
    ]);
  });
});

describe('toYamlString', () => {
  it('emits a parseable subset for the export bundle shape', () => {
    const yaml = toYamlString({
      version: 1,
      ref: { kind: 'universe', id: 'u1' },
      ingredients: [
        { id: 'cat-chr-1', type: 'character', name: 'Alice', tags: ['noir'], payload: { physicalDescription: 'curious' } },
      ],
    });
    expect(yaml).toMatch(/^version: 1\n/);
    expect(yaml).toContain('ref:\n');
    expect(yaml).toContain('kind: "universe"');
    expect(yaml).toContain('- id: "cat-chr-1"');
    expect(yaml).toContain('tags:\n');
    expect(yaml).toContain('- "noir"');
  });

  it('handles null / boolean / numeric scalars', () => {
    const yaml = toYamlString({ a: null, b: true, c: 42 });
    expect(yaml).toContain('a: null');
    expect(yaml).toContain('b: true');
    expect(yaml).toContain('c: 42');
  });

  it('emits empty array / object as the inline form', () => {
    const yaml = toYamlString({ tags: [], payload: {} });
    expect(yaml).toContain('tags: []');
    expect(yaml).toContain('payload: {}');
  });
});
