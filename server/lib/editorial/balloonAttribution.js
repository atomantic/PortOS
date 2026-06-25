/**
 * Comic speech-balloon attribution check — pure analysis over the parsed comic
 * pages `comicScriptParser` emits.
 *
 * Problem this catches: a dialogue line whose SPEAKER is not visible in the
 * panel and is not marked as speaking from off-panel/over a device/broadcast.
 * When that happens the image model letters a normal balloon and tails it to
 * whoever IS drawn — mis-attributing the line (the real bug: JUNO, the station
 * AI, "speaking" a line that got a tail pointing at a visible newlywed). The
 * render side translates an off-panel/broadcast modifier into a disembodied
 * balloon (see visualStages.js BALLOON_STYLE_HINTS); this check is the authoring
 * guard that flags the cases where that modifier is MISSING, so the script can
 * be fixed (show the speaker, or mark the line off-panel/broadcast) before art.
 *
 * Deterministic + side-effect-free (pure), so it's unit-testable and the same
 * helper can back both the server `comic.balloon-attribution` editorial check
 * and any future inline comic-script-stage warning.
 *
 * Conservative by design — it prefers a miss to a false alarm:
 *   - A speaker carrying ANY "voice from elsewhere" modifier (PA, off-panel,
 *     V.O., radio/earpiece/transmission, …) is treated as intentionally absent
 *     and never flagged — the author already declared the attribution.
 *   - Presence is checked PAGE-WIDE, not per-panel: a character shown in one
 *     panel persists through the scene, so a speaker named in ANY panel
 *     description on the page counts as present (kills the "shown in panel 1,
 *     speaks in panel 3" false positive that per-panel matching produces).
 *   - "Present" matches the speaker's full name OR any distinctive (≥4-char)
 *     token of it, so an incidental speaker the prose refers to loosely ("the
 *     newlyweds" vs "NEWLYWED TWO") reads as present rather than flagged.
 *   - Findings are deduped to ONE per (page, speaker): a narrator who speaks
 *     unshown across a whole page yields a single finding (with a panel count),
 *     not one per balloon — so the check stays advisory, not a flood.
 *   - Severity scales with risk: `medium` when another canon character IS named
 *     in the same panel (a concrete wrong target the balloon can tail to),
 *     `low` when no one is clearly visible (an orphaned/unclear balloon).
 */

// Speaker modifiers that mean "this speaker need not be drawn in the panel" —
// broadcast/PA, off-panel/off-screen, voice-over/narration, and transmission
// devices (the remote party isn't in frame). Mirrors the disembodied + device
// vocabulary in visualStages.js BALLOON_STYLE_HINTS — keep the two in sync.
// NOT included: whisper / shout / thought / sing — those imply the speaker IS
// present, so a missing on-panel speaker for them is still a real gap.
export const OFFPANEL_OK_MODIFIER =
  /\b(SPEAKERS?|P\.?A\.?|BROADCAST|ANNOUNCE(?:D|S|MENT)?|ANNOUNCER|LOUDSPEAKER|OVERHEAD|INTERCOM|TANNOY|PAGING|STATIONWIDE|SHIPWIDE|OFF[\s-]?PANEL|OFF[\s-]?SCREEN|O\.?\s?S\.?|O\.?\s?P\.?|V\.?\s?O\.?|VOICE[\s-]?OVER|NARRATION|NARRATOR|EARPIECE|RADIO|COMMS?|TRANSMISSION|PHONE|HOLO|HOLOGRAM|TV|MONITOR|VIDEO|COMLINK|CHANNEL|PHONE|COMM[\s-]?LINK)\b/i;

// The severity ranks a violation can take (most-severe first). Local copy so the
// module stays self-contained.
const ATTRIBUTION_SEVERITIES = ['high', 'medium', 'low'];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Split a `NAME (MODIFIER)` speaker token into { speaker, modifier }. Tolerates
// stacked parentheticals by treating the whole inner-paren blob as the modifier.
// Mirrors formatBalloon's split in visualStages.js.
export function splitSpeaker(character) {
  const raw = (typeof character === 'string' ? character : '').trim();
  const m = raw.match(/^([^(]+?)\s*\(([^)]*)\)\s*$/);
  return {
    speaker: (m ? m[1] : raw).trim(),
    modifier: m ? m[2].trim() : '',
  };
}

// Is `name` referenced in `text`? True on a word-boundary match of the full name
// OR any distinctive (≥4-char) token of it — case-insensitive. The token pass
// keeps loosely-named incidental speakers from false-flagging (see header).
export function nameInText(name, text) {
  const n = (typeof name === 'string' ? name : '').trim().toLowerCase();
  const t = (typeof text === 'string' ? text : '').toLowerCase();
  if (!n || !t) return false;
  if (new RegExp(`\\b${escapeRe(n)}\\b`).test(t)) return true;
  const tokens = n.split(/[^a-z0-9]+/).filter((tok) => tok.length >= 4);
  return tokens.some((tok) => new RegExp(`\\b${escapeRe(tok)}\\b`).test(t));
}

/**
 * Analyze the parsed pages of ONE comic script for balloon-attribution risks.
 *
 * @param {Array<{ panels: Array<object> }>} pages  parseComicScript(...).pages
 * @param {object} [opts]
 * @param {string[]} [opts.characterNames]  canon character display names (+ aliases)
 *   used to detect a concrete mis-attribution target in the panel description.
 * @returns {Array<object>} violations, one per (page, speaker), each:
 *   { pageNumber, panelNumber, speaker, line, severity, visibleOthers, panelCount, anchorQuote }
 *   `panelNumber`/`line`/`anchorQuote` point at the FIRST offending panel;
 *   `panelCount` is how many panels on the page have this unshown speaker.
 */
export function analyzeBalloonAttribution(pages, { characterNames = [] } = {}) {
  const list = Array.isArray(pages) ? pages : [];
  const names = (Array.isArray(characterNames) ? characterNames : [])
    .filter((n) => typeof n === 'string' && n.trim());
  const violations = [];
  list.forEach((page, pageIdx) => {
    const pageNumber = pageIdx + 1;
    const panels = Array.isArray(page?.panels) ? page.panels : [];
    // Page-wide description: a character shown anywhere on the page persists
    // through the scene, so presence is judged against the whole page, not the
    // single panel the line sits in.
    const pageText = panels
      .map((p) => (typeof p?.description === 'string' ? p.description : ''))
      .join('\n');
    // Accumulate per speaker so a narrator speaking unshown across the page is
    // ONE finding, not one per balloon.
    const bySpeaker = new Map();
    panels.forEach((panel, panelIdx) => {
      const panelNumber = panelIdx + 1;
      const description = typeof panel?.description === 'string' ? panel.description : '';
      const dialogue = Array.isArray(panel?.dialogue) ? panel.dialogue : [];
      if (!dialogue.length) return;
      const visibleCanon = names.filter((n) => nameInText(n, description));
      dialogue.forEach((d) => {
        const { speaker, modifier } = splitSpeaker(d?.character);
        if (!speaker) return;
        // Author marked it as a voice-from-elsewhere — intentional, not a gap.
        if (OFFPANEL_OK_MODIFIER.test(modifier)) return;
        // Speaker is shown somewhere on the page — a tailed balloon is fine.
        if (nameInText(speaker, pageText)) return;
        const visibleOthers = visibleCanon.filter((n) => n.toLowerCase() !== speaker.toLowerCase());
        const key = speaker.toLowerCase();
        const prior = bySpeaker.get(key);
        if (prior) {
          prior.panelCount += 1;
          // Escalate to medium if ANY panel has a concrete mis-attribution target.
          if (visibleOthers.length) {
            prior.severity = 'medium';
            for (const o of visibleOthers) if (!prior.visibleOthers.includes(o)) prior.visibleOthers.push(o);
          }
          return;
        }
        bySpeaker.set(key, {
          pageNumber,
          panelNumber,
          speaker,
          line: typeof d?.line === 'string' ? d.line : '',
          severity: visibleOthers.length ? 'medium' : 'low',
          visibleOthers: [...visibleOthers],
          panelCount: 1,
          anchorQuote: typeof d?.line === 'string' ? d.line.trim() : '',
        });
      });
    });
    violations.push(...bySpeaker.values());
  });
  return violations;
}

export { ATTRIBUTION_SEVERITIES };
