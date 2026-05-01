import { describe, it, expect } from 'vitest';
import { applyTemplate } from './promptTemplate.js';

describe('applyTemplate — variables', () => {
  it('substitutes flat keys', () => {
    expect(applyTemplate('Hello {{name}}', { name: 'World' })).toBe('Hello World');
  });

  it('substitutes nested keys via dot notation', () => {
    expect(applyTemplate('Hi {{user.first}} {{user.last}}', {
      user: { first: 'Adam', last: 'E' },
    })).toBe('Hi Adam E');
  });

  it('returns empty string for missing keys (does not leak literal {{x}})', () => {
    expect(applyTemplate('a={{a}} b={{b}}', { a: 1 })).toBe('a=1 b=');
  });

  it('handles deep nesting', () => {
    expect(applyTemplate('{{a.b.c.d}}', { a: { b: { c: { d: 'deep' } } } })).toBe('deep');
  });

  it('triple-mustache emits the raw value', () => {
    // Behaves the same as double for plain strings (we don't HTML-escape)
    // but documents intent for templates that emit pre-formatted markdown.
    expect(applyTemplate('{{{html}}}', { html: '## heading' })).toBe('## heading');
  });
});

describe('applyTemplate — sections', () => {
  it('renders a truthy section', () => {
    expect(applyTemplate('{{#flag}}yes{{/flag}}', { flag: true })).toBe('yes');
  });

  it('skips a falsy section', () => {
    expect(applyTemplate('before{{#flag}}MID{{/flag}}after', { flag: false })).toBe('beforeafter');
  });

  it('treats an empty array as falsy (Mustache spec)', () => {
    expect(applyTemplate('{{#items}}item{{/items}}', { items: [] })).toBe('');
  });

  it('treats an empty string as falsy', () => {
    expect(applyTemplate('a{{#name}}={{name}}{{/name}}', { name: '' })).toBe('a');
  });

  it('opens an object scope so child keys resolve naturally', () => {
    expect(applyTemplate('{{#user}}{{first}}{{/user}}', { user: { first: 'A' } })).toBe('A');
  });

  it('keeps parent scope visible inside a section body', () => {
    // user.first is in scope inside {{#flag}} since the parent context is
    // preserved (the section is truthy-but-non-object, so context is unchanged).
    expect(applyTemplate('{{#flag}}{{user.first}}{{/flag}}', {
      flag: true,
      user: { first: 'A' },
    })).toBe('A');
  });
});

describe('applyTemplate — array iteration', () => {
  it('iterates an array of objects, opening each as scope', () => {
    const out = applyTemplate('{{#items}}- {{name}}\n{{/items}}', {
      items: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
    });
    expect(out).toBe('- a\n- b\n- c\n');
  });

  it('iterates an array of primitives via {{.}}', () => {
    expect(applyTemplate('{{#xs}}[{{.}}]{{/xs}}', { xs: [1, 2, 3] })).toBe('[1][2][3]');
  });

  it('preserves outer context inside iteration', () => {
    // The cd-evaluate template needs `{{project.id}}` to remain visible
    // inside `{{#evaluationFrames}}` — this asserts that contract.
    const out = applyTemplate(
      '{{#frames}}{{label}}@{{project.id}};{{/frames}}',
      { project: { id: 'cd-1' }, frames: [{ label: 'a' }, { label: 'b' }] },
    );
    expect(out).toBe('a@cd-1;b@cd-1;');
  });
});

describe('applyTemplate — inverted sections', () => {
  it('renders content when key is missing or falsy', () => {
    expect(applyTemplate('{{^flag}}nope{{/flag}}', {})).toBe('nope');
    expect(applyTemplate('{{^flag}}nope{{/flag}}', { flag: false })).toBe('nope');
    expect(applyTemplate('{{^items}}empty{{/items}}', { items: [] })).toBe('empty');
  });

  it('hides content when key is truthy', () => {
    expect(applyTemplate('{{^flag}}nope{{/flag}}', { flag: true })).toBe('');
    expect(applyTemplate('{{^items}}nope{{/items}}', { items: [1] })).toBe('');
  });

  it('pairs naturally with truthy sections for if/else', () => {
    const tpl = '{{#multiFrame}}MULTI{{/multiFrame}}{{^multiFrame}}SINGLE{{/multiFrame}}';
    expect(applyTemplate(tpl, { multiFrame: true })).toBe('MULTI');
    expect(applyTemplate(tpl, { multiFrame: false })).toBe('SINGLE');
  });
});
