/**
 * Character definitions — the sanitizing boundary between a provider answer (or
 * a stored, possibly hand-edited record) and the inline SVG the sheet embeds.
 * The security-relevant contract: nothing but validated numbers, hex colors and
 * drawing commands ever reaches the markup.
 */

import { describe, it, expect } from 'vitest';
import { normalizeDefinitions, renderDefinitionsSection } from './castAndSetsDefinitions.js';

const character = () => ({
  id: 'Boat',
  name: 'Paper boat',
  renderer: 'svg',
  palette: [{ name: 'Cream', hex: '#F5F0E6' }, { name: 'Ember', hex: '#ff5a1f' }],
  parts: [
    { id: 'hull', shape: 'polygon', points: [[40, 120], [160, 120], [130, 160], [70, 160]], fill: 'cream', stroke: 'ember', strokeWidth: 3 },
    { id: 'sail', shape: 'path', d: 'M100 40 L100 120 L150 120 Z', fill: 'ember', pivot: [100, 120] },
    { id: 'eye', shape: 'circle', x: 90, y: 135, r: 5, fill: '#000' },
  ],
  expressions: [{ name: 'Proud', overrides: { sail: { rotate: -10, scale: 1.1 }, eye: { hidden: true }, ghost: { rotate: 3 } } }],
  poses: [{ name: 'Lean', overrides: { hull: { translate: [4, 0], rotate: 6 } } }],
  motion: [{ name: 'Bob', target: 'hull', property: 'translateY', amplitude: 4, periodBeats: 1, easing: 'ease-in-out', trigger: 'beat' }],
});

describe('normalizeDefinitions', () => {
  it('bounds and canonicalizes a character, dropping what does not validate', () => {
    const raw = character();
    raw.parts.push({ id: 'bad', shape: 'path', d: 'M0 0 <script>alert(1)</script>' }, { id: 'huge', shape: 'circle', x: 9999, y: -4, r: 'NaN' }, { shape: 'blob' });
    const { characters } = normalizeDefinitions({ characters: [raw] });
    const [c] = characters;
    expect(c.id).toBe('boat');
    expect(c.palette).toEqual([{ name: 'cream', hex: '#f5f0e6' }, { name: 'ember', hex: '#ff5a1f' }]);
    expect(c.parts.map((p) => p.id)).toEqual(['hull', 'sail', 'eye']);
    expect(c.parts[0]).toMatchObject({ fill: 'cream', stroke: 'ember' });
    // An override naming no part is dropped; the rest survive.
    expect(c.expressions[0].overrides).toEqual({ sail: { rotate: -10, scale: 1.1 }, eye: { hidden: true } });
    expect(c.motion[0]).toMatchObject({ target: 'hull', property: 'translateY', trigger: 'beat' });
  });

  it('separates absent, unusable and intentionally empty', () => {
    expect(normalizeDefinitions(undefined)).toBeNull();
    expect(normalizeDefinitions('nope')).toBeNull();
    expect(normalizeDefinitions({ characters: [{ name: 'No parts' }, 'x'] })).toBeNull();
    expect(normalizeDefinitions({ characters: [] })).toEqual({ characters: [] });
  });

  it('is idempotent, so a stored record re-validates to itself', () => {
    const once = normalizeDefinitions({ characters: [character()] });
    expect(normalizeDefinitions(once)).toEqual(once);
  });
});

describe('renderDefinitionsSection', () => {
  it('draws the base pose and applies a named expression to the right part', () => {
    const tiles = renderDefinitionsSection({ characters: [character()] }).split('<figure').slice(1);
    const [base, proud] = tiles;
    expect(base).toContain('<svg viewBox="0 0 200 200"');
    expect(base).toContain('fill="#f5f0e6"');
    expect(base).not.toContain('rotate(-10');
    expect(proud).toContain('rotate(-10 100 120)');
    // The part the expression hides is not drawn in it.
    expect(base).toContain('<circle');
    expect(proud).not.toContain('<circle');
  });

  it('never emits script, URLs or injected markup, even from a hand-edited record', () => {
    const hostile = character();
    hostile.name = '"><script>alert(1)</script>';
    hostile.parts[1].d = 'M0 0 L1 1" onload="alert(1)';
    hostile.parts[2].fill = 'url(http://example.com/x)';
    hostile.motion[0].note = '<img src=x onerror=alert(1)>';
    const html = renderDefinitionsSection({ characters: [hostile] });
    expect(html).toContain('<svg');
    // Free text is escaped; the unusable path and fill never reach the markup.
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toMatch(/<script|<img|onload|http|url\(/i);
  });

  it('renders nothing for a direction without definitions', () => {
    expect(renderDefinitionsSection(undefined)).toBe('');
    expect(renderDefinitionsSection({ characters: [] })).toBe('');
  });
});
