/**
 * Dashboard widgets lay out by CONTAINER query, never by viewport breakpoint.
 *
 * `client/src/components/dashboard/AGENTS.md` states the rule; this guard is
 * what stops it drifting back. A dashboard cell is a column of a 12-column
 * grid, so a `quarter` widget is ~250px wide no matter how wide the monitor is
 * — and on a 2560px screen every `sm:`/`md:`/`lg:` inside it is unconditionally
 * true. The result is the widest layout pinned into the narrowest column:
 * System Health rendered its five metric tiles `lg:grid-cols-5` at ~40px each,
 * so "Memory"/"CPU"/"Processes" overlapped into an unreadable band, and the
 * `hidden sm:inline` label on "Mark as seen" expanded the button until the
 * While-You-Were-Away heading wrapped one word per line. Both got *worse* on a
 * narrow monitor, because a narrower viewport packs the same columns into less
 * room while still satisfying `sm:`.
 *
 * The rule: a component reachable from `WIDGETS` in `widgetRegistry.jsx` may
 * not carry a bare viewport variant in a class string. Put `@container` on the
 * component's own root and prefix its layout classes `@sm:`/`@md:`/`@lg:` —
 * on the component, not the grid cell, since the same component also renders
 * in drawers and full-width pages that provide no container ancestor.
 *
 * Scope is the registry's own modules (not their whole import closure): those
 * are the components the grid sizes, and a shared primitive used on real pages
 * too has a viewport of its own to answer to. Widgets that genuinely need a
 * viewport variant — a hover-vs-touch affordance is about the device, not the
 * box — go in ALLOWED with the reason.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join, dirname, normalize } from 'path';
import { fileURLToPath } from 'url';
import { lineOf, maskComments, stringLiterals } from './test/classNameScan.js';

const SRC_ROOT = dirname(fileURLToPath(import.meta.url));
const REGISTRY = 'components/dashboard/widgetRegistry.jsx';

/**
 * Widgets that legitimately answer to the viewport, with the reason they do.
 * A row here is a design call about the *device* (pointer type, screen), never
 * a way past the guard for a layout that is really about the cell's width.
 */
const ALLOWED = new Map();

// `sm:` … `2xl:` at the head of a class token, but not `@sm:` (container) and
// not the tail of some other variant (`group-hover:`, `max-sm:`).
const VIEWPORT_VARIANT = /(?:^|\s)(sm|md|lg|xl|2xl):[\w[\]().\-/:]+/g;

/** Source files of every component the widget registry lazy-imports. */
export function widgetSources(srcRoot = SRC_ROOT) {
  const registry = maskComments(readFileSync(join(srcRoot, REGISTRY), 'utf8'));
  const specifiers = [...registry.matchAll(/lazyWithReload\(\(\) => import\('([^']+)'\)\)/g)]
    .map((m) => m[1]);
  return specifiers.map((specifier) => {
    const base = normalize(join(dirname(REGISTRY), specifier));
    const resolved = ['.jsx', '.js', '/index.jsx']
      .map((ext) => `${base}${ext}`)
      .find((candidate) => existsSync(join(srcRoot, candidate)));
    if (!resolved) throw new Error(`widgetRegistry imports an unresolvable module: ${specifier}`);
    return resolved;
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

const findViolations = (file) => violationsIn(readFileSync(join(SRC_ROOT, file), 'utf8'), file);

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
    const violations = files
      .filter((file) => !ALLOWED.has(file))
      .flatMap((file) => findViolations(file));
    expect(violations).toEqual([]);
  });

  it('keeps the allowlist honest — every exempt widget still has the variant it was exempted for', () => {
    const stale = [...ALLOWED.keys()].filter((file) => findViolations(file).length === 0);
    expect(stale).toEqual([]);
  });
});
