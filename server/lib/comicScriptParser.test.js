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
    expect(parseComicScript('')).toEqual({ coverConcept: '', backCoverConcept: '', pages: [] });
    expect(parseComicScript(null)).toEqual({ coverConcept: '', backCoverConcept: '', pages: [] });
    expect(parseComicScript('# Just a title')).toEqual({ coverConcept: '', backCoverConcept: '', pages: [] });
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

  it('extracts the `## Back cover concept` section into backCoverConcept', () => {
    const script = `# Issue 1 — Bone Walker

## Cover concept

KESSA on the rib spine.

## Back cover concept

The beetle alone on a moonlit dune, single point-of-interest silhouette, no text, no logos.

## Page 1

Panel 1
Description: A frame.
`;
    const { coverConcept, backCoverConcept } = parseComicScript(script);
    expect(coverConcept).toMatch(/KESSA on the rib spine/);
    expect(backCoverConcept).toMatch(/beetle alone on a moonlit dune/);
    expect(backCoverConcept).not.toMatch(/KESSA/);
  });

  it('captures back-cover when only the back-cover section is present', () => {
    const script = `## Back cover concept

Just the back.

## Page 1

Panel 1
Description: A frame.
`;
    const { coverConcept, backCoverConcept } = parseComicScript(script);
    expect(coverConcept).toBe('');
    expect(backCoverConcept).toMatch(/Just the back/);
  });

  it('accepts the short `## Back cover` heading', () => {
    const script = `## Back cover

Short form.

## Page 1

Panel 1
Description: A frame.
`;
    expect(parseComicScript(script).backCoverConcept).toMatch(/Short form/);
  });

  it('handles back-cover before cover (any order)', () => {
    const script = `## Back cover concept

Back text.

## Cover concept

Front text.

## Page 1

Panel 1
Description: A frame.
`;
    const { coverConcept, backCoverConcept } = parseComicScript(script);
    expect(coverConcept).toMatch(/Front text/);
    expect(backCoverConcept).toMatch(/Back text/);
  });

  it('terminates an in-progress back-cover block at any other H2', () => {
    const script = `## Back cover concept

Real back-cover content.

## Notes

Editorial scratchpad — should not appear in backCoverConcept.

## Page 1

Panel 1
Description: A frame.
`;
    const { backCoverConcept } = parseComicScript(script);
    expect(backCoverConcept).toMatch(/Real back-cover content/);
    expect(backCoverConcept).not.toMatch(/Editorial scratchpad/);
  });

  it('returns empty backCoverConcept when the script has no Back cover section', () => {
    const script = `## Cover concept

Only a front.

## Page 1

Panel 1
Description: A frame.
`;
    expect(parseComicScript(script).backCoverConcept).toBe('');
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

// Imported comic scripts use the bare screenplay convention (uppercase
// `PAGE`/`PANEL` headers, label-on-its-own-line CAPTION/SFX/dialogue). The
// parser normalizes that to the canonical form in memory so the verbatim
// imported script still renders into pages/panels.
describe('parseComicScript — bare imported format', () => {
  const BARE = `PAGE 1
A small village sits against a mountain. This page is the dream of Giant.
PANEL 1
Giant descends from the castle on a Summer day, full of smiles.
CAPTION
I am sorry to say, this isn't real.
PANEL 2
Birds sing around Giant as he enters the town.
CAPTION
It's not even realistic.
PAGE 2
PANEL 1
He spreads his arms wide and gold coins swarm into the streets.
PANEL 2
Close up on Giant with a wide grin.
GIANT
The curse is…
CAPTION
Woah. Slow down big fella...
PANEL 3
Giant is heaved into a black panel.
SFX
Thud!`;

  it('splits bare PAGE/PANEL headers into pages and panels', () => {
    const { pages } = parseComicScript(BARE);
    expect(pages).toHaveLength(2);
    expect(pages[0].panels).toHaveLength(2);
    expect(pages[1].panels).toHaveLength(3);
  });

  it('reads the first block after PANEL as the description, verbatim', () => {
    const { pages } = parseComicScript(BARE);
    expect(pages[0].panels[0].description).toMatch(/Giant descends from the castle/);
    expect(pages[0].panels[1].description).toMatch(/Birds sing around Giant/);
  });

  it('reads CAPTION / SFX label-lines and their following text', () => {
    const { pages } = parseComicScript(BARE);
    expect(pages[0].panels[0].caption).toBe("I am sorry to say, this isn't real.");
    expect(pages[1].panels[2].sfx).toBe('Thud!');
  });

  it('reads a SPEAKER cue line + the next line as dialogue', () => {
    const { pages } = parseComicScript(BARE);
    expect(pages[1].panels[1].dialogue).toEqual([{ character: 'GIANT', line: 'The curse is…' }]);
    // The CAPTION after the dialogue still attaches to the same panel.
    expect(pages[1].panels[1].caption).toBe('Woah. Slow down big fella...');
  });

  it('parses Title Case bare headers (Page/Panel/Caption), matching the case-insensitive splitter', () => {
    // The mechanical splitter accepts `Page 1` / `Panel 1` case-insensitively
    // and seeds them verbatim into stages.comicScript; the parser MUST match
    // the same case variants or the import renders zero panels.
    const { pages } = parseComicScript('Page 1\nPanel 1\nA scene.\nCaption\nHello there.\nPage 2\nPanel 1\nAnother.');
    expect(pages).toHaveLength(2);
    expect(pages[0].panels[0].description).toBe('A scene.');
    expect(pages[0].panels[0].caption).toBe('Hello there.');
    expect(pages[1].panels[0].description).toBe('Another.');
  });

  it('still rejects prose that opens with the keyword (number-token gate, any case)', () => {
    expect(parseComicScript('Pages turned slowly through the long evening as she read.').pages).toHaveLength(0);
  });

  it('does NOT treat a content line that starts with "Page N …" as a new page header', () => {
    // A panel description like "Page 1 of the ancient book lies open." must stay
    // description — prefix-only markers used to consume it as a PAGE header and
    // drop the panel. Standalone-header anchoring (number then EOL/punct only).
    const { pages } = parseComicScript('PAGE 1\nPANEL 1\nPage 1 of the ancient book lies open.\nCAPTION\nThe end.');
    expect(pages).toHaveLength(1);
    expect(pages[0].panels).toHaveLength(1);
    expect(pages[0].panels[0].description).toBe('Page 1 of the ancient book lies open.');
    expect(pages[0].panels[0].caption).toBe('The end.');
  });

  it('leaves an inline "Caption: text" first line for FIELD_RE (not forced to description)', () => {
    const { pages } = parseComicScript('PAGE 1\nPANEL 1\nCaption: It was night.\nPANEL 2\nA wide shot.');
    expect(pages[0].panels[0].caption).toBe('It was night.');
    expect(pages[0].panels[1].description).toBe('A wide shot.');
  });

  it('leaves canonical Markdown scripts untouched (no false bare-detection)', () => {
    const { pages } = parseComicScript(SAMPLE);
    // Same result the canonical-format tests assert — normalization skipped.
    expect(pages).toHaveLength(2);
    expect(pages[0].panels[0].description).toMatch(/Wide establishing shot/);
    expect(pages[1].panels[0].caption).toMatch(/inside of a dead god/);
  });

  it('does NOT misread a terse all-caps panel description as a speaker cue', () => {
    const { pages } = parseComicScript('PAGE 1\nPANEL 1\nTHE CITY BURNS AT NIGHT\nGIANT\nStop right there!');
    expect(pages[0].panels[0].description).toBe('THE CITY BURNS AT NIGHT');
    expect(pages[0].panels[0].dialogue).toEqual([{ character: 'GIANT', line: 'Stop right there!' }]);
  });

  it('keeps all-caps SFX content (KRAKOOM) as SFX, not a speaker', () => {
    const { pages } = parseComicScript('PAGE 1\nPANEL 1\nA wide shot of the blast.\nSFX\nKRAKOOM\nGIANT\nNo!');
    expect(pages[0].panels[0].sfx).toBe('KRAKOOM');
    expect(pages[0].panels[0].dialogue).toEqual([{ character: 'GIANT', line: 'No!' }]);
  });

  it('does not treat a slugline-style description (has a period) as a speaker', () => {
    const { pages } = parseComicScript('PAGE 1\nPANEL 1\nINT. VAULT - NIGHT. Dust everywhere.\nCAPTION\nIt was quiet.');
    expect(pages[0].panels[0].description).toMatch(/INT\. VAULT - NIGHT/);
    expect(pages[0].panels[0].caption).toBe('It was quiet.');
    expect(pages[0].panels[0].dialogue).toEqual([]);
  });

  it('keeps a caption-only bare panel (no description) instead of dropping it', () => {
    const { pages } = parseComicScript('PAGE 1\nPANEL 1\nCAPTION\nIn the beginning, there was nothing.');
    expect(pages).toHaveLength(1);
    expect(pages[0].panels).toHaveLength(1);
    expect(pages[0].panels[0].caption).toBe('In the beginning, there was nothing.');
  });

  it('captures every line of a multi-line balloon under one speaker cue', () => {
    // A speaker followed by multiple lines before the next cue/label must keep
    // ALL lines — earlier only the first survived and the rest were dropped.
    const { pages } = parseComicScript('PAGE 1\nPANEL 1\nA face.\nGIANT\nThe curse is broken.\nFinally, after all these years.\nCAPTION\nThe end.');
    expect(pages[0].panels[0].dialogue).toEqual([
      { character: 'GIANT', line: 'The curse is broken.' },
      { character: 'GIANT', line: 'Finally, after all these years.' },
    ]);
    expect(pages[0].panels[0].caption).toBe('The end.');
  });

  it('preserves a dangling speaker cue (no spoken line before the next marker) as text, not dropped', () => {
    const { pages } = parseComicScript('PAGE 1\nPANEL 1\nA face.\nGIANT\nPANEL 2\nAnother shot.');
    // GIANT had no spoken line before PANEL 2 — it must survive in the panel
    // text rather than vanish or fabricate dialogue.
    expect(pages[0].panels[0].description).toContain('GIANT');
    expect(pages[0].panels[0].dialogue).toEqual([]);
    expect(pages[0].panels).toHaveLength(2);
  });
});
