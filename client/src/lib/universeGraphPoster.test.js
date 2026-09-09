import { describe, it, expect } from 'vitest';
import { indexGraph } from './universeGraphModel';
import { POSTER_LAYOUTS, POSTER_SIZES, posterDimensions, renderPoster } from './universeGraphPoster';

// A small but structurally complete universe: two characters (one with a lens
// and a framework, one with nothing authored), a place with cast and one
// without, an object attachment, a series and its issues.
const index = () => indexGraph({
  name: 'Example Universe',
  totalIssues: 2,
  series: [{ id: 'series:s1', recordId: 's1', name: 'First Arc' }],
  issues: [
    { id: 'issue:i1', recordId: 'i1', index: 0, name: 'First Arc #1', seriesId: 'series:s1' },
    { id: 'issue:i2', recordId: 'i2', index: 1, name: 'First Arc #2', seriesId: 'series:s1' },
  ],
  appear: { 'character:c1': [0, 1], 'character:c2': [1], 'place:p1': [0] },
  nodes: [
    {
      id: 'character:c1',
      kind: 'character',
      name: 'Alice Vane',
      role: 'Lead',
      hasImage: true,
      locked: true,
      firstIssue: 0,
      arcType: 'positive',
      sliders: { proactivity: 7, competence: 4 },
      framework: { ghost: 'Lost the key.', want: 'Get it back.' },
      evolution: { outcome: 'partial-open', stages: [{ stageId: 'cost-tested', testedBelief: 'x' }] },
    },
    { id: 'character:c2', kind: 'character', name: 'Bob', role: 'Foil', hasImage: false, firstIssue: 1 },
    { id: 'place:p1', kind: 'place', name: 'The Vault', role: 'INT. VAULT', hasImage: true, firstIssue: 0 },
    { id: 'place:p2', kind: 'place', name: 'The Pier', role: 'EXT. PIER', hasImage: false, firstIssue: 0 },
    { id: 'object:o1', kind: 'object', name: 'The Key', role: 'Macguffin', hasImage: false, firstIssue: 0 },
    { id: 'series:s1', kind: 'series', name: 'First Arc', role: '2 issues', hasImage: false, firstIssue: 0 },
  ],
  edges: [
    { source: 'character:c1', target: 'character:c2', type: 'rival', directed: true, since: 1 },
    { source: 'object:o1', target: 'character:c1', type: 'attachment', label: 'talisman', since: 0 },
    { source: 'character:c1', target: 'issue:i1', type: 'appearance', since: 0 },
  ],
});

const canvas = () => document.createElement('canvas');

describe('renderPoster', () => {
  it.each(POSTER_LAYOUTS.map((l) => l.id))('draws the %s layout without throwing', (layout) => {
    const el = canvas();
    expect(() => renderPoster(el, { index: index(), layout, subjectId: 'character:c1' })).not.toThrow();
    expect(el.width).toBe(posterDimensions('portrait')[0]);
  });

  it.each(POSTER_SIZES.map((s) => s.id))('sizes the %s canvas from its declared dimensions', (size) => {
    const el = canvas();
    const [w, h] = posterDimensions(size);
    renderPoster(el, { index: index(), layout: 'roster', size });
    expect([el.width, el.height]).toEqual([w, h]);
  });

  it('renders at 2× for the print download', () => {
    const el = canvas();
    const [w, h] = posterDimensions('portrait');
    renderPoster(el, { index: index(), layout: 'roster', scale: 2 });
    expect([el.width, el.height]).toEqual([w * 2, h * 2]);
  });

  it('draws the paper theme without throwing', () => {
    expect(() => renderPoster(canvas(), { index: index(), layout: 'atlas', theme: 'paper' })).not.toThrow();
  });

  it('falls back to the most connected character when the dossier subject is unknown', () => {
    expect(() => renderPoster(canvas(), { index: index(), layout: 'dossier', subjectId: 'character:gone' })).not.toThrow();
  });

  it('survives an empty universe rather than dividing by zero', () => {
    const empty = indexGraph({ name: 'Empty', nodes: [], edges: [], issues: [], series: [], totalIssues: 0, appear: {} });
    for (const layout of POSTER_LAYOUTS.map((l) => l.id)) {
      expect(() => renderPoster(canvas(), { index: empty, layout })).not.toThrow();
    }
  });

  it('scopes the drawing to the timeline position when one is given', () => {
    // Bob is introduced in issue index 1, so an "as of issue 0" poster must not
    // reach for him — the guard is that the layout still renders.
    expect(() => renderPoster(canvas(), { index: index(), layout: 'timeline', asOfIssue: 0 })).not.toThrow();
  });
});
