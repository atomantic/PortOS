/**
 * Cover lettering layout (#10345): a design stored before the treatments
 * existed lays out exactly as before, and each new treatment changes only what
 * it names. Pure SVG-string assertions; the real render is in
 * services/musicVideo/coverArt.test.js.
 */
import { describe, expect, it } from 'vitest';
import { coverOverlaySvg, DEFAULT_COVER_DESIGN, normalizeCoverDesign } from './musicVideoCoverOverlay.js';

const SONG = { title: 'Example Song', tag: 'Example Artist', size: 1000 };
// The first y a <text> is drawn at, per text content.
const textY = (svg, content) => Number(new RegExp(`<text[^>]* y="([\\d.]+)"[^>]*>${content}</text>`).exec(svg)?.[1]);

describe('cover design normalization', () => {
  it('reads a design stored before titleStyle and tagLayout existed as the default treatment', () => {
    const legacy = { layout: 'top-left', typeface: 'serif', weight: 'light', letterCase: 'lower', scale: 'large', tracking: 0.1, titleColor: '#112233', accentColor: '#445566', backdrop: 'band', tagStyle: 'boxed', rule: true };
    expect(normalizeCoverDesign(legacy)).toEqual({ ...legacy, titleStyle: 'fill', tagLayout: 'opposite-corner' });
    expect(normalizeCoverDesign({})).toEqual(DEFAULT_COVER_DESIGN);
    expect(coverOverlaySvg({ ...SONG, design: legacy })).toBe(coverOverlaySvg({ ...SONG, design: { ...legacy, titleStyle: 'fill', tagLayout: 'opposite-corner' } }));
  });

  it('accepts an uploaded typeface only while that font exists', () => {
    const fonts = [{ id: 'example-font', family: 'Example Font', width: 0.5 }];
    expect(normalizeCoverDesign({ typeface: 'font:example-font' }, { fonts }).typeface).toBe('font:example-font');
    expect(normalizeCoverDesign({ typeface: 'font:example-font' }).typeface).toBe('sans');
    expect(normalizeCoverDesign({ typeface: 'font:other' }, { fonts }).typeface).toBe('sans');
    // The layout wraps by the font's measured width, and names its family.
    const svg = coverOverlaySvg({ ...SONG, design: { typeface: 'font:example-font' }, fonts });
    expect(svg).toContain(`font-family="'Example Font',sans-serif"`);
  });
});

describe('cover lettering treatments', () => {
  it('draws an outline title hollow, and a stencil title through a mask that cuts every line', () => {
    const outline = coverOverlaySvg({ ...SONG, design: { titleStyle: 'outline', titleColor: '#ff0000' } });
    expect(outline).toMatch(/<text[^>]*fill="none" stroke="#ff0000"/);
    expect(outline).not.toContain('<mask');

    const stencil = coverOverlaySvg({ ...SONG, title: 'Example Song With A Longer Name', design: { titleStyle: 'stencil', scale: 'large' } });
    expect(stencil).toContain('<g mask="url(#stencil)">');
    const cuts = stencil.match(/<mask[\s\S]*?<\/mask>/)[0].match(/fill="#000"/g);
    expect(cuts.length).toBeGreaterThan(1); // one cut per title line
  });

  it('sets the artist tag under the title when asked, inside the margin, instead of across the cover', () => {
    const apart = coverOverlaySvg({ ...SONG, design: { layout: 'bottom-left', tagLayout: 'opposite-corner' } });
    const together = coverOverlaySvg({ ...SONG, design: { layout: 'bottom-left', tagLayout: 'with-title' } });
    // Apart: the tag is up at the top edge, far from the title. Together: it sits just below the title, above the bottom margin.
    expect(textY(apart, 'EXAMPLE ARTIST')).toBeLessThan(textY(apart, 'EXAMPLE SONG'));
    expect(textY(together, 'EXAMPLE ARTIST')).toBeGreaterThan(textY(together, 'EXAMPLE SONG'));
    expect(textY(together, 'EXAMPLE ARTIST')).toBeLessThan(1000 * (1 - 0.065));
    // A cover with no artist tag has nothing to reserve room for: the title does not move.
    const alone = coverOverlaySvg({ ...SONG, tag: '', design: { layout: 'bottom-left', tagLayout: 'with-title' } });
    expect(textY(alone, 'EXAMPLE SONG')).toBe(textY(apart, 'EXAMPLE SONG'));
  });
});

describe('YouTube thumbnail lettering', () => {
  const THUMB = { title: 'Example Song Title', tag: 'Example Artist', size: { width: 1280, height: 720 }, frame: 'thumbnail' };
  const fontSizes = (svg) => [...svg.matchAll(/font-size="([\d.]+)"/g)].map((m) => Number(m[1]));

  it('sets the title larger than a cover would on the same height, with no artist name', () => {
    const svg = coverOverlaySvg({ ...THUMB, design: { layout: 'bottom-left' } });
    expect(svg).toContain('width="1280" height="720" viewBox="0 0 1280 720"');
    expect(svg).not.toContain('EXAMPLE ARTIST');
    const cover = coverOverlaySvg({ title: THUMB.title, tag: THUMB.tag, size: 720, design: { layout: 'bottom-left' } });
    expect(Math.max(...fontSizes(svg))).toBeGreaterThan(Math.max(...fontSizes(cover)) * 1.4);
  });

  it('keeps a side-anchored title to one side and every bottom layout above the duration badge', () => {
    // An average-advance layout: the line's right edge is x + chars × advance × size.
    const left = coverOverlaySvg({ ...THUMB, design: { layout: 'bottom-left', typeface: 'sans' } });
    const lines = [...left.matchAll(/<text x="([\d.]+)" y="[\d.]+"[^>]*font-size="([\d.]+)"[^>]*>([^<]+)<\/text>/g)];
    expect(lines.length).toBeGreaterThan(1);
    for (const [, x, fs, line] of lines) expect(Number(x) + line.length * 0.6 * 1.02 * Number(fs)).toBeLessThanOrEqual(1280 * 0.46 + 1);
    for (const layout of ['bottom-left', 'bottom-center']) {
      const svg = coverOverlaySvg({ ...THUMB, design: { layout } });
      const lowest = Math.max(...[...svg.matchAll(/<text[^>]* y="([\d.]+)"/g)].map((m) => Number(m[1])));
      expect(lowest).toBeLessThan(720 * (1 - 0.14));
    }
  });
});
