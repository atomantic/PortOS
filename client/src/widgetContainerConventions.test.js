import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maskComments, stringLiterals } from './test/classNameScan.js';

const root = dirname(fileURLToPath(import.meta.url));
const registryDir = resolve(root, 'components/dashboard');
const registry = readFileSync(resolve(registryDir, 'widgetRegistry.jsx'), 'utf8');
const widgets = [...registry.matchAll(/import\('([^']+)'\)/g)].map(([, path]) => `${path}.jsx`);
// Device-specific hover/touch variants are deliberately outside this layout rule.
const viewportLayout = /(?:^|\s)(?:sm|md|lg|xl|2xl):(?:grid-cols-|flex-(?:row|col)|(?:min-|max-)?w-|p[xytrbl]?-|gap-|hidden\b|inline\b|inline-flex\b)/;
const violations = (source) => stringLiterals(maskComments(source))
  .filter(({ value }) => viewportLayout.test(value)).map(({ value }) => value);

describe('dashboard widget container layout', () => {
  it('detects viewport layout while allowing container queries and device hover affordances', () => {
    expect(violations('<div className="grid grid-cols-1 lg:grid-cols-5" />')).toHaveLength(1);
    expect(violations('<div className="grid grid-cols-1 @lg:grid-cols-5 md:opacity-0" />')).toEqual([]);
  });

  it('all registered widget roots use container-aware layout variants', () => {
    expect(widgets.length).toBeGreaterThan(20);
    const findings = widgets.flatMap(path => violations(readFileSync(resolve(registryDir, path), 'utf8'))
      .map(value => `${path}: ${value}`));
    expect(findings).toEqual([]);
  });
});
