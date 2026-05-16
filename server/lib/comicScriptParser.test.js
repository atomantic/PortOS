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
    expect(parseComicScript('')).toEqual({ coverConcept: '', pages: [] });
    expect(parseComicScript(null)).toEqual({ coverConcept: '', pages: [] });
    expect(parseComicScript('# Just a title')).toEqual({ coverConcept: '', pages: [] });
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

  it('extracts the `## Cover concept` section into coverConcept and keeps it out of page 1\'s rawText', () => {
    const script = `# Issue 1 — Bone Walker

## Cover concept

KESSA crouched on the rib spine at dawn, beetle in her cupped hand, the sky behind her bruised purple.

## Page 1

Panel 1
Description: Wide establishing shot inside the rib.
`;
    const { coverConcept, pages } = parseComicScript(script);
    expect(coverConcept).toMatch(/KESSA crouched on the rib spine/);
    expect(pages).toHaveLength(1);
    expect(pages[0].rawText).toMatch(/Wide establishing shot/);
    expect(pages[0].rawText).not.toMatch(/rib spine at dawn/);
  });

  it('also accepts the short `## Cover` heading', () => {
    const script = `## Cover

Brief cover sketch.

## Page 1

Panel 1
Description: A frame.
`;
    expect(parseComicScript(script).coverConcept).toMatch(/Brief cover sketch/);
  });

  it('terminates an in-progress cover block at any other H2 (e.g. `## Notes`)', () => {
    const script = `## Cover concept

The cover.

## Notes

Editorial scratchpad — should not appear in coverConcept.

## Page 1

Panel 1
Description: A frame.
`;
    const { coverConcept } = parseComicScript(script);
    expect(coverConcept).toMatch(/The cover\./);
    expect(coverConcept).not.toMatch(/Editorial scratchpad/);
  });

  it('returns empty coverConcept when the script has no Cover section', () => {
    const script = `## Page 1

Panel 1
Description: A frame.
`;
    expect(parseComicScript(script).coverConcept).toBe('');
  });

  it('captures the raw page body for each page', () => {
    const { pages } = parseComicScript(SAMPLE);
    expect(pages[0].rawText).toMatch(/### Panel 1/);
    expect(pages[0].rawText).toMatch(/Wide establishing shot/);
    expect(pages[0].rawText).toMatch(/### Panel 2/);
    expect(pages[0].rawText).toMatch(/KESSA:/);
    // The page-2 boundary should not leak into page-1's rawText.
    expect(pages[0].rawText).not.toMatch(/dead god/);
  });

  it('parses the new plain format (no markdown-bold field labels, no `###` panel headers)', () => {
    const script = `# Issue 1 — Bone Walker

## Page 1

Panel 1
Description: Wide establishing shot inside a fossilized rib, sun streaming in.
Caption: The titan died nine thousand years ago.
Dialogue: (none)
SFX: (none)

Panel 2
Description: Tight close-up — a beetle picks its way along polished bone.
Caption: No one has told the rib.
Dialogue:
- KESSA: "Beetle. If you had any sense, you'd stow away."
SFX: "fmp"
`;
    const { pages } = parseComicScript(script);
    expect(pages).toHaveLength(1);
    expect(pages[0].panels).toHaveLength(2);
    expect(pages[0].panels[0].description).toMatch(/establishing shot/);
    expect(pages[0].panels[0].caption).toMatch(/titan died/);
    expect(pages[0].panels[1].dialogue).toEqual([
      { character: 'KESSA', line: "Beetle. If you had any sense, you'd stow away." },
    ]);
    expect(pages[0].panels[1].sfx).toMatch(/fmp/);
  });

  it('does not start a new panel when "Panel N" appears mid-description', () => {
    // Regression: the relaxed plain-panel regex must require the panel header
    // to be a standalone line. Without the end-anchor, a description line
    // like "Panel 2 is offline on the monitor." used to split the panel.
    const script = `## Page 1

Panel 1
Description: A wide shot of the security room. Panel 2 is offline on the monitor in the corner. Etta studies the dead feed.
Caption: A quiet sweep before the storm.
`;
    const { pages } = parseComicScript(script);
    expect(pages).toHaveLength(1);
    expect(pages[0].panels).toHaveLength(1);
    expect(pages[0].panels[0].description).toMatch(/Panel 2 is offline on the monitor/);
  });

  it('accepts the `Panel N (DPS)` double-page-spread header form', () => {
    const script = `## Page 1

Panel 1 (DPS)
Description: A bold double-page spread of the city skyline at dawn.

Panel 2
Description: Tight on Kessa's hands clutching the railing.
`;
    const { pages } = parseComicScript(script);
    expect(pages).toHaveLength(1);
    expect(pages[0].panels).toHaveLength(2);
    expect(pages[0].panels[0].description).toMatch(/double-page spread/);
    expect(pages[0].panels[1].description).toMatch(/clutching the railing/);
  });

  it('caps rawText at PAGE_SCRIPT_MAX', () => {
    // Build a page with a single panel whose description is enormous, then
    // assert the page's rawText is bounded. We can't import PANEL_LIMITS
    // here without a circular-style import in the test — the assertion just
    // proves a hard cap exists.
    const fat = 'lorem ipsum dolor sit amet '.repeat(5000); // ~135 KB
    const script = `## Page 1\n\nPanel 1\nDescription: ${fat}\n`;
    const { pages } = parseComicScript(script);
    expect(pages).toHaveLength(1);
    expect(pages[0].rawText.length).toBeLessThanOrEqual(40_000);
  });
});
