/**
 * Rule: Components reachable from `WIDGETS` in `widgetRegistry.jsx` must use `@container` + `@sm:`/`@md:`/`@lg:` container queries, never bare viewport breakpoints (see `client/src/components/dashboard/AGENTS.md`).
 * Fix: Put `@container` on the component's root and prefix layout classes with `@sm:`/`@md:`/`@lg:`.
 * What this guard cannot see:
 *   - Scoped to `widgetRegistry.jsx`'s own modules, not their transitive import closure.
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { join, dirname, normalize } from 'path';
import { lineOf, maskComments, stringLiterals } from '../../classNameScan.js';
import { readText, REPO_ROOT } from '../../../../../scripts/lib/guardCorpus.js';

const SRC_ROOT = join(REPO_ROOT, 'client/src');
const REGISTRY = 'components/dashboard/widgetRegistry.jsx';

// `sm:` … `2xl:` at the head of a class token, but not `@sm:` (container) and
// not the tail of some other variant (`group-hover:`, `max-sm:`).
const VIEWPORT_VARIANT = /(?:^|\s)(sm|md|lg|xl|2xl):[\w[\]().\-/:]+/g;

/** Source files of every component the widget registry lazy-imports. */
export function widgetSources(srcRoot = SRC_ROOT) {
  const registry = maskComments(readText(join(srcRoot, REGISTRY)));
  const specifiers = [...registry.matchAll(/lazyWithReload\(\(\) => import\('([^']+)'\)\)/g)]
    .map((m) => m[1]);
  return specifiers.map((specifier) => {
    const base = normalize(join(dirname(REGISTRY), specifier));
    const resolved = ['.jsx', '.js', '/index.jsx']
      .map((ext) => `${base}${ext}`)
      .find((candidate) => existsSync(join(srcRoot, candidate)));
    if (!resolved) throw new Error(`widgetRegistry imports an unresolvable module: ${specifier}`);
    return resolved.split('\\').join('/');
  });
}

export function violationsIn(rawSource, file) {
  const source = maskComments(rawSource);
  return stringLiterals(source).flatMap(({ value, index }) => {
    VIEWPORT_VARIANT.lastIndex = 0;
    return [...value.matchAll(VIEWPORT_VARIANT)]
      .map((m) => `${file}:${lineOf(source, index)} — "${m[0].trim()}"`);
  });
}

const findViolations = (file) => violationsIn(readText(join(SRC_ROOT, file)), file);

describe('dashboard widget container-query conventions', () => {
  const files = widgetSources();

  it('resolves every widget the registry declares', () => {
    // The registry is the contract; a silently-empty scan is a green guard
    // that proves nothing.
    expect(files.length).toBeGreaterThanOrEqual(25);
    expect(files).toContain('components/SystemHealthWidget.jsx');
    expect(files).toContain('components/dashboard/builtins/QuickStatsWidget.jsx');
  });

  it('flags a viewport variant and clears every container form', () => {
    const flagged = (markup) => violationsIn(`<div className="${markup}" />`, 'probe.jsx').length;
    expect(flagged('grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3')).toBe(2);
    expect(flagged('hidden sm:inline')).toBe(1);
    expect(flagged('p-4 sm:p-6')).toBe(1);
    expect(flagged('grid grid-cols-2 @sm:grid-cols-3 @2xl:grid-cols-5 gap-3')).toBe(0);
    expect(flagged('@container rounded-xl p-4 @md:p-6')).toBe(0);
    // Not a viewport variant: the tail of a compound one, or a max-width form.
    expect(flagged('md:opacity-0 group-hover:opacity-100')).toBe(1);
    expect(flagged('max-sm:sr-only')).toBe(0);
    // A doc comment quoting an example class string is not markup.
    expect(violationsIn('// e.g. "p-4 sm:p-6"', 'probe.jsx')).toEqual([]);
  });

  it('never sizes a widget by the viewport', () => {
    const violations = files.flatMap((file) => findViolations(file));
    expect(violations).toEqual([]);
  });
});
