import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  listPartialReferences,
  expandPartialsWithResolver,
  expandPartials,
} from './promptPartials.js';

let partialsDir;

beforeEach(() => {
  partialsDir = mkdtempSync(join(tmpdir(), 'pp-test-'));
});

afterEach(() => {
  if (partialsDir && existsSync(partialsDir)) rmSync(partialsDir, { recursive: true, force: true });
});

function writePartial(name, body) {
  writeFileSync(join(partialsDir, `${name}.md`), body);
}

describe('listPartialReferences', () => {
  it('finds all unique partial names in a template', () => {
    const tmpl = 'before {{> alpha }} mid {{>beta}} more {{>alpha}} end';
    expect(listPartialReferences(tmpl)).toEqual(['alpha', 'beta']);
  });

  it('tolerates whitespace variations inside the include', () => {
    expect(listPartialReferences('{{>foo}}{{> foo }}{{>  foo  }}')).toEqual(['foo']);
  });

  it('returns [] for empty / non-string / no-references input', () => {
    expect(listPartialReferences('')).toEqual([]);
    expect(listPartialReferences(null)).toEqual([]);
    expect(listPartialReferences('no partials here {{var}} {{#section}}body{{/section}}')).toEqual([]);
  });
});

describe('expandPartialsWithResolver (sync)', () => {
  it('rewrites every {{> name }} to the resolver-returned body', () => {
    const out = expandPartialsWithResolver(
      'A {{> x }} B {{> y }} C',
      (name) => (name === 'x' ? '[X]' : '[Y]'),
    );
    expect(out).toBe('A [X] B [Y] C');
  });

  it('recurses through nested partials', () => {
    const resolver = (name) => {
      if (name === 'outer') return 'outer-open {{> inner }} outer-close';
      if (name === 'inner') return 'INNER';
      return null;
    };
    expect(expandPartialsWithResolver('top {{> outer }} bot', resolver))
      .toBe('top outer-open INNER outer-close bot');
  });

  it('throws on a self-referencing partial (cycle guard)', () => {
    const resolver = (name) => (name === 'loop' ? 'a {{> loop }} z' : null);
    expect(() => expandPartialsWithResolver('{{> loop }}', resolver))
      .toThrow(/MAX_DEPTH|cyclic/i);
  });

  it('throws on a missing partial rather than silently emptying it', () => {
    expect(() => expandPartialsWithResolver('{{> missing }}', () => null))
      .toThrow(/Prompt partial not found: "missing"/);
  });

  it('returns identical input when no partials are referenced (no-op fast path)', () => {
    const input = 'plain text {{var}} {{#s}}body{{/s}}';
    expect(expandPartialsWithResolver(input, () => '???')).toBe(input);
  });

  it('returns "" for non-string input', () => {
    expect(expandPartialsWithResolver(null, () => '')).toBe('');
    expect(expandPartialsWithResolver(undefined, () => '')).toBe('');
  });
});

describe('expandPartials (async, fs-backed)', () => {
  it('reads partials from disk and inlines them', async () => {
    writePartial('alpha', 'ALPHA-BODY');
    writePartial('beta', 'BETA-BODY');
    const out = await expandPartials('1 {{> alpha }} 2 {{> beta }} 3', { partialsDir });
    expect(out).toBe('1 ALPHA-BODY 2 BETA-BODY 3');
  });

  it('handles transitively-referenced partials (a → b → c)', async () => {
    writePartial('a', 'a-open {{> b }} a-close');
    writePartial('b', 'b-open {{> c }} b-close');
    writePartial('c', 'C-BODY');
    const out = await expandPartials('{{> a }}', { partialsDir });
    expect(out).toBe('a-open b-open C-BODY b-close a-close');
  });

  it('throws on a missing partial file', async () => {
    await expect(expandPartials('{{> ghost }}', { partialsDir }))
      .rejects.toThrow(/Prompt partial not found: "ghost"/);
  });

  it('short-circuits when the template references no partials (no fs reads)', async () => {
    const input = 'just plain prose {{var}}';
    const out = await expandPartials(input, { partialsDir });
    expect(out).toBe(input);
  });

  it('detects a cyclic include chain and throws', async () => {
    writePartial('p', '{{> q }}');
    writePartial('q', '{{> p }}');
    await expect(expandPartials('{{> p }}', { partialsDir }))
      .rejects.toThrow(/MAX_DEPTH|cyclic/i);
  });

  it('rejects when partialsDir is missing', async () => {
    await expect(expandPartials('{{> x }}', {}))
      .rejects.toThrow(/partialsDir is required/);
  });

  it('passes Mustache variables through the partial body verbatim (the var pass runs later)', async () => {
    // Partials don't render variables themselves — they just emit body text
    // that the downstream applyTemplate pass interpolates against the
    // shared context. Round-trip check.
    writePartial('greet', 'Hello {{name}}, welcome to {{place}}.');
    const out = await expandPartials('-- {{> greet }} --', { partialsDir });
    expect(out).toBe('-- Hello {{name}}, welcome to {{place}}. --');
  });
});
