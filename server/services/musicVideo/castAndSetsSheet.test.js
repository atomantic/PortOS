/**
 * The Cast & Sets check-in sheet is a self-contained file the director opens
 * in a sandboxed viewer (or on its own): every section of the hand-made sheet,
 * no network reference of any kind, and no way for direction text or an image
 * source to inject markup.
 */

import { describe, it, expect } from 'vitest';
import { renderCastAndSetsSheet } from './castAndSetsSheet.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const direction = {
  logline: 'A keeper <signals> & waits.',
  interpretation: 'Read as a vigil kept for someone lost at sea.',
  protagonist: { name: 'Nova', description: 'the voice', face: 'weathered', hair: 'grey braid', signature: 'a lantern', gesture: 'lantern raised', rules: ['No hats'] },
  looks: [{ name: 'Lab', description: 'hoodie', chapters: 'verses' }],
  sets: [
    { id: 'lab', name: 'Lab', description: 'a lamp room', lighting: 'green', sections: ['Verse'] },
    { id: 'roof', name: 'Roof', description: 'rain', lighting: 'red', sections: ['Outro'] },
    { id: 'hall', name: 'Hall', description: 'beacons', lighting: 'red', sections: [] },
  ],
  songMap: [{ section: 0, setId: 'lab' }, { section: 1, setId: 'roof' }],
  tests: [{ setId: 'lab', look: 'Lab', action: 'trimming the wick', caption: 'the long night' }, { setId: 'roof', look: 'Lab', action: 'running', caption: 'outside' }],
  overlayConcept: { summary: 'One meter.', elements: [{ name: 'Meter', description: 'falls' }] },
  questions: ['Is she right?'],
};
const sections = [{ index: 0, label: 'Verse', startSec: 0, endSec: 30 }, { index: 1, label: 'Outro', startSec: 30, endSec: 60 }];

describe('Cast & Sets sheet', () => {
  it('renders every section of the check-in, self-contained', () => {
    const html = renderCastAndSetsSheet({
      title: 'Example Song', direction, sections, durationSec: 60, bpm: 120, revision: 2,
      notesApplied: [{ target: 'character', text: 'No hats' }],
      images: { character: PNG, looks: PNG, expressions: PNG, 'set:lab': PNG, 'set:roof': PNG, 'test:1': PNG, 'test:2': 'https://example.com/x.png' },
    });
    for (const heading of ['Protagonist', 'In-set tests', 'Sets', 'Song map', 'Overlay layer', 'What I need from you']) {
      expect(html).toContain(heading);
    }
    expect(html).toContain('Nova');
    expect(html).toContain('No hats');
    expect(html).toContain('Revision 2');
    // The song map bar: one segment per section, colored by its set.
    expect(html.match(/class="seg"/g)).toHaveLength(2);
    expect(html).toContain('Verse 0:00–0:30 · Lab');
    // Direction text is escaped, never markup.
    expect(html).toContain('A keeper &lt;signals&gt; &amp; waits.');
    // No network reference at all: a non-data image source becomes a placeholder.
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<(script|link|iframe)\b/i);
    expect(html).toContain('Image not rendered');
    // The set with no image yet is a placeholder too.
    expect(html.match(/data:image\/png;base64/g)).toHaveLength(7);
  });

  it('previews the reusable character definitions as inline SVG, still with no network or script', () => {
    const procedural = {
      ...direction, medium: 'procedural', looks: [], tests: [],
      protagonist: { name: 'Boat', description: 'a paper boat', construction: 'three folds' },
      definitions: { characters: [{
        id: 'boat', name: 'Paper boat', renderer: 'svg', palette: [{ name: 'cream', hex: '#f5f0e6' }],
        parts: [{ id: 'hull', shape: 'rect', x: 40, y: 100, width: 120, height: 40, fill: 'cream' }],
        expressions: [{ name: 'proud', overrides: { hull: { rotate: -5 } } }], poses: [],
        motion: [{ name: 'Bob', target: 'hull', property: 'translateY', amplitude: 4, periodBeats: 1, easing: 'ease-in-out', trigger: 'beat' }],
      }] },
    };
    const html = renderCastAndSetsSheet({ title: 'Example Song', direction: procedural, sections });
    expect(html).toContain('Reusable code definitions');
    // Base pose + the named expression, each its own drawing; palette and motion listed.
    expect(html.match(/<svg viewBox="0 0 200 200"/g)).toHaveLength(2);
    expect(html).toContain('rotate(-5 100 120)');
    expect(html).toContain('Bob');
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<(script|link|iframe|image|use)\b/i);
    // A procedural direction without definitions shows no empty section.
    expect(renderCastAndSetsSheet({ title: 'Example Song', direction: { ...procedural, definitions: { characters: [] } }, sections })).not.toContain('Character design');
  });
});
