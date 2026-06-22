import { describe, it, expect } from 'vitest';
import {
  analyzeBalloonAttribution,
  splitSpeaker,
  nameInText,
  OFFPANEL_OK_MODIFIER,
} from './balloonAttribution.js';

const page = (panels) => ({ panels });
const panel = (description, dialogue) => ({ description, dialogue });

describe('splitSpeaker', () => {
  it('splits NAME (MODIFIER)', () => {
    expect(splitSpeaker('JUNO (SPEAKERS)')).toEqual({ speaker: 'JUNO', modifier: 'SPEAKERS' });
    expect(splitSpeaker('Maggie')).toEqual({ speaker: 'Maggie', modifier: '' });
    expect(splitSpeaker('LINA (EARPIECE, WHISPERED)')).toEqual({ speaker: 'LINA', modifier: 'EARPIECE, WHISPERED' });
  });
});

describe('nameInText', () => {
  it('matches full name and distinctive tokens case-insensitively', () => {
    expect(nameInText('Maggie', 'Maggie ducks behind a crate.')).toBe(true);
    expect(nameInText('Dr. Thomas Russo', 'A dark figure — RUSSO — steps out.')).toBe(true); // token match
    expect(nameInText('Kai', 'Two newlyweds laugh.')).toBe(false);
  });
  it('does not match a short token substring', () => {
    expect(nameInText('JUNO', 'The junior clerk frowns.')).toBe(false); // no \bjuno\b
  });
});

describe('OFFPANEL_OK_MODIFIER', () => {
  it('recognizes broadcast/off-panel/V.O./transmission, not whisper/thought', () => {
    for (const m of ['SPEAKERS', 'PA', 'BROADCAST', 'OVERHEAD', 'OFF-PANEL', 'O.S.', 'V.O.', 'RADIO', 'EARPIECE', 'INTERCOM']) {
      expect(OFFPANEL_OK_MODIFIER.test(m)).toBe(true);
    }
    for (const m of ['WHISPERED', 'THOUGHT', 'SHOUTING', 'SINGING', '']) {
      expect(OFFPANEL_OK_MODIFIER.test(m)).toBe(false);
    }
  });
});

describe('analyzeBalloonAttribution', () => {
  it('flags an unshown speaker with no off-panel cue, medium when another canon character is visible', () => {
    const pages = [page([
      panel('Maggie crouches at the containment rail, alone with the readout.', [
        { character: 'KAI', line: 'You absolute menace.' },
      ]),
    ])];
    const v = analyzeBalloonAttribution(pages, { characterNames: ['Maggie', 'Kai'] });
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ pageNumber: 1, panelNumber: 1, speaker: 'KAI', severity: 'medium' });
    expect(v[0].visibleOthers).toContain('Maggie');
  });

  it('flags low when the speaker is unshown and no other character is visible', () => {
    const pages = [page([
      panel('An empty corridor, lights flickering.', [
        { character: 'KAI', line: 'Anyone there?' },
      ]),
    ])];
    const v = analyzeBalloonAttribution(pages, { characterNames: ['Maggie', 'Kai'] });
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe('low');
  });

  it('does NOT flag a speaker marked off-panel / broadcast / transmission', () => {
    const pages = [page([
      panel('Two newlyweds duck under exploding light-orbs.', [
        { character: 'JUNO (SPEAKERS)', line: 'Beverages are permitted.' },
        { character: 'MAGGIE (V.O.)', line: 'Not for long.' },
        { character: 'TOM (RADIO)', line: 'On my way.' },
      ]),
    ])];
    const v = analyzeBalloonAttribution(pages, { characterNames: ['Maggie', 'Tom', 'Juno'] });
    expect(v).toHaveLength(0);
  });

  it('does NOT flag a speaker who is shown in the panel description', () => {
    const pages = [page([
      panel('Maggie leans over the rail as Kai works the console.', [
        { character: 'KAI', line: 'Almost in.' },
        { character: 'MAGGIE', line: 'Hurry.' },
      ]),
    ])];
    const v = analyzeBalloonAttribution(pages, { characterNames: ['Maggie', 'Kai'] });
    expect(v).toHaveLength(0);
  });

  it('does NOT flag a speaker shown in an earlier panel on the same page (scene persistence)', () => {
    // Kai is described in panel 1, speaks in panel 3 without being re-described —
    // page-wide presence must treat him as present, not flag him.
    const pages = [page([
      panel('Kai lounges against a coral-lit pillar, slate under one arm.', []),
      panel('Close on the security console, glyphs scrolling.', []),
      panel('The console blooms green.', [{ character: 'KAI', line: 'Almost in.' }]),
    ])];
    const v = analyzeBalloonAttribution(pages, { characterNames: ['Kai'] });
    expect(v).toHaveLength(0);
  });

  it('dedups to one finding per (page, speaker) with a panel count', () => {
    const pages = [page([
      panel('An empty maintenance ring hums.', [{ character: 'KAI', line: 'Line one.' }]),
      panel('Sparks drift past dead consoles.', [{ character: 'KAI', line: 'Line two.' }]),
    ])];
    const v = analyzeBalloonAttribution(pages, { characterNames: ['Kai'] });
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ speaker: 'KAI', panelCount: 2, panelNumber: 1 });
  });

  it('tolerates missing/empty input', () => {
    expect(analyzeBalloonAttribution(null)).toEqual([]);
    expect(analyzeBalloonAttribution([page([panel('x', [])])])).toEqual([]);
    expect(analyzeBalloonAttribution([page([panel('x', [{ character: '', line: 'hi' }])])])).toEqual([]);
  });
});
