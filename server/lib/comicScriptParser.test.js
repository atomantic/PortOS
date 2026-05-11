import { describe, expect, it } from 'vitest';
import { parseComicScript } from './comicScriptParser.js';

const SAMPLE = `# Issue 1 — Bone Walker

## Page 1

### Panel 1
**Description:** Wide establishing shot inside the curve of an enormous fossilized rib, lit by long slanting bars of morning sun.
**Caption:** The titan died nine thousand years ago.
**Dialogue:** (none)
**SFX:** (none)

### Panel 2
**Description:** Tight close-up — a thumb-sized iridescent beetle picks its way along a stripe of sunlight on polished bone.
**Caption:** No one has told the rib.
**Dialogue:**
- KESSA: "Beetle. If you had any **sense**, you'd stow away."
**SFX:** "fmp"

## Page 2

### Panel 1
**Description:** Large panel. The interior of the rib-colony seen from the catwalk.
**Caption:** This is the inside of a dead god.
**Caption 2:** It is also home.
**Dialogue:** (none)
**SFX:** (distant) "dum… dum-dum…"
`;

describe('parseComicScript', () => {
  it('splits into pages and panels with descriptions', () => {
    const { pages } = parseComicScript(SAMPLE);
    expect(pages).toHaveLength(2);
    expect(pages[0].panels).toHaveLength(2);
    expect(pages[1].panels).toHaveLength(1);
    expect(pages[0].panels[0].description).toMatch(/establishing shot/);
    expect(pages[0].panels[0].imageJobId).toBeNull();
  });

  it('normalizes (none) to empty', () => {
    const { pages } = parseComicScript(SAMPLE);
    expect(pages[0].panels[0].caption).toMatch(/titan died/);
    expect(pages[0].panels[0].sfx).toBe('');
    expect(pages[0].panels[0].dialogue).toEqual([]);
  });

  it('parses dialogue list into character/line pairs', () => {
    const { pages } = parseComicScript(SAMPLE);
    expect(pages[0].panels[1].dialogue).toEqual([
      { character: 'KESSA', line: 'Beetle. If you had any **sense**, you\'d stow away.' },
    ]);
  });

  it('joins multi-line captions (Caption + Caption 2)', () => {
    const { pages } = parseComicScript(SAMPLE);
    expect(pages[1].panels[0].caption).toMatch(/inside of a dead god/);
    expect(pages[1].panels[0].caption).toMatch(/also home/);
  });

  it('handles empty / non-string input', () => {
    expect(parseComicScript('')).toEqual({ pages: [] });
    expect(parseComicScript(null)).toEqual({ pages: [] });
    expect(parseComicScript('# Just a title')).toEqual({ pages: [] });
  });

  it('drops panels with no description and pages with no panels', () => {
    const script = `## Page 1

### Panel 1
**Caption:** floating header

### Panel 2
**Description:** Real panel.

## Page 2
`;
    const { pages } = parseComicScript(script);
    expect(pages).toHaveLength(1);
    expect(pages[0].panels).toHaveLength(1);
    expect(pages[0].panels[0].description).toMatch(/Real panel/);
  });
});
