/**
 * The tree-wide static-import-cycle ratchet for `server/services` (#5693).
 *
 * A static ESM cycle is a boot-order hazard: whichever member evaluates first
 * sees `undefined` for the others' bindings, so a top-level `const` derived from
 * an imported value anywhere in the ring is a TDZ crash that no behavior test
 * notices until an unrelated import-order change surfaces it.
 *
 * Two guards already prove specific clusters acyclic — `agentImportCycles.test.js`
 * (#2837/#3450) and `twinImportCycles.test.js` (#5687) — and both deliberately
 * ignore a cycle that misses their cluster. That left the rest of a 1000-module
 * directory unguarded: nothing stopped a new service from closing the next ring.
 * This suite covers everything, and the cluster guards keep their own assertions
 * (facade re-export rules, deferred-import bans) because those check properties a
 * general acyclicity walk does not.
 *
 * **A shrinking baseline, not a hard zero.** Three cyclic components are live
 * today; fixing them all in one PR would be un-reviewable, so each is recorded
 * below against the issue that removes it, and the assertions run BOTH ways:
 * a component that is not in the baseline fails (no new cycles from today), and
 * a baseline entry that is no longer detected fails too (a fixed cycle must be
 * deleted from the list, so the baseline can only shrink and cannot rot).
 *
 * **Why components and not rendered rings.** `findImportCycles` reports the
 * rings its depth-first walk happens to close, which depends on where the walk
 * enters a component — and it enters wherever `readdirSync` put the first file,
 * i.e. filesystem order, not alphabetical. That is fine for the cluster guards,
 * which only ask "is this empty?", and useless as a baseline: the same untouched
 * graph would produce a different list on another machine. Strongly-connected
 * components are a property of the edges alone, so this list means the same thing
 * everywhere. It is also the truer picture — for the autopilot/creativeDirector
 * cycle #5920 removed, the DFS walk named 8 modules; the component was 22.
 *
 * Static edges only. `await import()` is deferred to call time and cannot
 * produce a load-time cycle, so breaking a cycle by deferring an import does not
 * count as a fix — see the deferred-import guards in `agentImportCycles.test.js`.
 */

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { buildStaticImportGraph, findImportCycles, findImportCycleComponents } from '../lib/staticImportGraph.js';

const SERVICES_DIR = dirname(fileURLToPath(import.meta.url));

// Every cyclic component still live in `server/services`, each against the issue
// that removes it. Delete an entry the moment its cycle is broken — the second
// assertion below fails while a fixed entry is still listed, which is what stops
// this list from becoming a wish.
const KNOWN_CYCLIC_COMPONENTS = [
  // #5919 — the receive path reaches subscription state back through the barrel.
];

// A component as one comparable string. Members arrive sorted from
// `findImportCycleComponents`, and the baseline is sorted here rather than by
// hand so an entry typed in a readable order still matches.
const componentKey = (members) => [...members].sort().join(' + ');

describe('server/services — static import cycle ratchet (#5693)', () => {
  const graph = buildStaticImportGraph(SERVICES_DIR);
  const detected = findImportCycleComponents(graph);

  it('sees the whole services graph', () => {
    // Every assertion below is a negative or a set comparison, so a resolver gap
    // that emptied the graph would read as a clean sweep. Pin the scale first.
    expect(graph.size, 'services graph looks empty — did the scan root move?').toBeGreaterThan(500);
    const withEdges = [...graph.values()].filter(deps => deps.length > 0);
    expect(withEdges.length, 'no module has any resolved edge — the specifier resolver is broken')
      .toBeGreaterThan(100);
  });

  it('detects a cycle in a hand-built graph', () => {
    // Negative control for the detector itself: without this, a
    // `findImportCycleComponents` that always returned `[]` would make the
    // no-new-cycles assertion pass vacuously forever.
    const cyclic = new Map([
      ['a.js', ['b.js']],
      ['b.js', ['c.js']],
      ['c.js', ['a.js']],
      ['leaf.js', ['a.js']],
    ]);
    expect(findImportCycleComponents(cyclic).map(members => componentKey(members)))
      .toEqual(['a.js + b.js + c.js']);

    // And the converse: an acyclic graph must report nothing, or the assertion
    // would be satisfied by a detector that flags everything.
    expect(findImportCycleComponents(new Map([['a.js', ['b.js']], ['b.js', []]]))).toEqual([]);

    // A module importing itself is a cycle of one, and the members-length test
    // inside the component walk is the only thing separating it from the ~1000
    // acyclic single-module components it must not report.
    expect(findImportCycleComponents(new Map([['a.js', ['a.js']]]))).toEqual([['a.js']]);
  });

  it('closes no static import cycle that is not already in the baseline', () => {
    const known = new Set(KNOWN_CYCLIC_COMPONENTS.map(entry => componentKey(entry.members)));
    const unexpected = detected.map(members => componentKey(members)).filter(key => !known.has(key));

    // Name the actual rings for a component that is new or that grew — the member
    // list says WHAT is tangled, the rings say which edges tangled it.
    const rings = unexpected.length
      ? findImportCycles(graph).filter(cycle =>
        unexpected.some(key => cycle.split(' -> ').some(module => key.split(' + ').includes(module))))
      : [];
    expect(unexpected, [
      'new or grown static import cycle in server/services:',
      ...unexpected,
      ...(rings.length ? ['', 'rings closing it:', ...rings] : []),
      '',
      'Break the cycle — import the module that DECLARES the symbol, not the barrel that',
      'forwards it. Deferring the import with `await import()` hides it from this guard',
      'without removing the boot-order hazard, so it is not a fix.',
    ].join('\n')).toEqual([]);
  });

  it('keeps no baseline entry for a cycle that is already fixed', () => {
    const live = new Set(detected.map(members => componentKey(members)));
    const stale = KNOWN_CYCLIC_COMPONENTS
      .map(entry => ({ ...entry, key: componentKey(entry.members) }))
      .filter(entry => !live.has(entry.key));

    expect(stale.map(entry => `#${entry.issue}: ${entry.key}`), [
      'these baseline entries no longer match a live cycle — the cycle was broken, or',
      'the component shrank and the entry needs re-recording. Update KNOWN_CYCLIC_COMPONENTS',
      'in this file; the baseline only ever shrinks.',
    ].join('\n')).toEqual([]);
  });

  it('records each baseline entry once, against a real issue', () => {
    const keys = KNOWN_CYCLIC_COMPONENTS.map(entry => componentKey(entry.members));
    expect(keys.length, 'a component is listed twice in the baseline').toBe(new Set(keys).size);
    for (const entry of KNOWN_CYCLIC_COMPONENTS) {
      expect(entry.issue, `baseline entry ${componentKey(entry.members)} names no tracking issue`)
        .toBeGreaterThan(0);
      expect(entry.members.length, 'a cyclic component has at least one member').toBeGreaterThan(0);
    }
  });
});
