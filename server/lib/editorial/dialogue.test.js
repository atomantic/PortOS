import { describe, it, expect } from 'vitest';
import {
  findSaidBookisms,
  findUnattributedDialogueRuns,
  attributeDialogueByOwner,
  inventoryDialogueTags,
  splitScenes,
  findDialogueTagVariety,
  SAID_BOOKISMS,
  NON_SPEECH_TAGS,
} from './dialogue.js';

describe('findSaidBookisms', () => {
  it('flags an ornate speech tag after a quote (verb before speaker)', () => {
    const hits = findSaidBookisms('"I disagree," expostulated Marlon.');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ verb: 'expostulate', kind: 'bookism' });
  });

  it('flags an ornate tag after a quote (speaker before verb)', () => {
    const hits = findSaidBookisms('"Indeed," she opined, leaning back.');
    expect(hits.map((h) => h.verb)).toContain('opine');
    expect(hits.find((h) => h.verb === 'opine').kind).toBe('bookism');
  });

  it('flags an ornate tag before an opening quote', () => {
    const hits = findSaidBookisms('Marlon interjected, "Wait."');
    expect(hits.map((h) => h.verb)).toContain('interject');
  });

  it('flags non-speech actions misused as tags ("she smiled")', () => {
    const hits = findSaidBookisms('"Of course," she smiled.');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ verb: 'smile', kind: 'non-speech' });
  });

  it('does NOT flag a narrated verb that is not a dialogue tag', () => {
    // No quote adjacent — "growled" here is narration about an engine.
    expect(findSaidBookisms('The engine growled as it turned over.')).toEqual([]);
  });

  it('does NOT flag a capitalized new-sentence subject after a quote (narration, not a tag)', () => {
    // "Thunder" is a bookism-list word, but here it's the subject of a new
    // narrated sentence after "Run!" — a real tag verb is lowercase.
    expect(findSaidBookisms('"Run!" Thunder rolled overhead.')).toEqual([]);
    expect(findSaidBookisms('"Stop!" Hiss of steam filled the room.')).toEqual([]);
  });

  it('does NOT flag plain "said" / "asked" tags', () => {
    expect(findSaidBookisms('"Hello," she said. "How are you?" he asked.')).toEqual([]);
  });

  it('does NOT flag an action beat after a complete (period-terminated) line', () => {
    // "Of course." is a complete sentence; "She smiled." is a separate, correct
    // action beat — the very construction the non-speech suggestion recommends.
    expect(findSaidBookisms('"Of course." She smiled.')).toEqual([]);
    expect(findSaidBookisms('"I quit." Marlon shrugged and left.')).toEqual([]);
  });

  it('flags a comma-attached non-speech tag but not its period-terminated beat form', () => {
    expect(findSaidBookisms('"Of course," she smiled.')).toHaveLength(1); // comma → misused tag
    expect(findSaidBookisms('"Of course." She smiled.')).toEqual([]);     // period → action beat
  });

  it('flags an ornate speech verb after ? or ! but not after a period', () => {
    expect(findSaidBookisms('"Why?" he expostulated.').map((h) => h.verb)).toContain('expostulate');
    // After a period the following clause is a new sentence, not a tag.
    expect(findSaidBookisms('"I see." He opined for a while.')).toEqual([]);
  });

  it('anchors the verb-before-speaker branch ("…," opined Marlon)', () => {
    const hits = findSaidBookisms('"Indeed," opined Marlon.');
    expect(hits).toHaveLength(1);
    expect(hits[0].verb).toBe('opine');
  });

  it('matches inflected forms (base, -s, -ed) including qu-stem doubling', () => {
    expect(findSaidBookisms('"No," he snarls.').map((h) => h.verb)).toContain('snarl');
    expect(findSaidBookisms('"No," he snarled.').map((h) => h.verb)).toContain('snarl');
    // quip → quipped: the `u` is a qu-onset, not the vowel (regression for the CVC gap).
    expect(findSaidBookisms('"Ha," he quipped.').map((h) => h.verb)).toContain('quip');
  });

  it('honors allowWords (mutes a base) and extraWords (adds a base)', () => {
    expect(findSaidBookisms('"Yes," she purred.', { allowWords: ['purr'] })).toEqual([]);
    const hits = findSaidBookisms('"Yes," she gushed.', { extraWords: ['gush'] });
    expect(hits.map((h) => h.verb)).toContain('gush');
  });

  it('dedupes a tag matched by both regexes and returns position order', () => {
    const hits = findSaidBookisms('"A," he opined. "B," she retorted.');
    const verbs = hits.map((h) => h.verb);
    expect(verbs).toEqual(['opine', 'retort']);
    // Each tag reported once even though two patterns can match it.
    expect(new Set(hits.map((h) => h.index)).size).toBe(hits.length);
  });

  it('returns [] for non-strings and empty input', () => {
    expect(findSaidBookisms('')).toEqual([]);
    expect(findSaidBookisms(null)).toEqual([]);
  });

  it('seed lists are non-empty and lowercase base forms', () => {
    expect(SAID_BOOKISMS.length).toBeGreaterThan(10);
    expect(NON_SPEECH_TAGS.length).toBeGreaterThan(5);
    for (const w of [...SAID_BOOKISMS, ...NON_SPEECH_TAGS]) expect(w).toBe(w.toLowerCase());
  });
});

describe('findUnattributedDialogueRuns', () => {
  // Six consecutive bare dialogue lines, no tags or beats → one run.
  const bareRun = [
    '"You came back."',
    '"I had to."',
    '"After everything?"',
    '"Especially after everything."',
    '"And now?"',
    '"Now we finish it."',
  ].join('\n');

  it('flags a long run of untagged dialogue', () => {
    const runs = findUnattributedDialogueRuns(bareRun);
    expect(runs).toHaveLength(1);
    expect(runs[0].count).toBe(6);
    expect(runs[0].anchor).toBe('"You came back."');
  });

  it('does NOT flag a short exchange below the threshold', () => {
    const short = '"Hi."\n"Hello."\n"Bye."';
    expect(findUnattributedDialogueRuns(short)).toEqual([]);
  });

  it('does NOT treat a tag word INSIDE the quote as attribution', () => {
    // "I said no." contains "said", but it's spoken text, not a tag — the run
    // must still be detected (attribution is measured on the narration, not the
    // quoted dialogue).
    const withTagWordInQuote = [
      '"You came back."',
      '"I said no."',
      '"After everything?"',
      '"Especially after everything."',
      '"And now?"',
      '"Now we finish it."',
    ].join('\n');
    const runs = findUnattributedDialogueRuns(withTagWordInQuote);
    expect(runs).toHaveLength(1);
    expect(runs[0].count).toBe(6);
  });

  it('a speech tag re-anchors and breaks the run', () => {
    const tagged = [
      '"You came back."',
      '"I had to," she said.',
      '"After everything?"',
      '"Especially after everything."',
      '"And now?"',
      '"Now we finish it."',
    ].join('\n');
    // The longest unattributed sub-run is 4 (< default 6) → no finding.
    expect(findUnattributedDialogueRuns(tagged)).toEqual([]);
  });

  it('an action beat counts as attribution', () => {
    const beat = [
      '"You came back."',
      'She set the lantern down on the cold stone floor and waited.',
      '"After everything?"',
      '"Especially after everything."',
      '"And now?"',
      '"Now we finish it."',
    ].join('\n');
    // The narration paragraph breaks the run; neither side reaches 6.
    expect(findUnattributedDialogueRuns(beat)).toEqual([]);
  });

  it('respects a custom minRun', () => {
    const three = '"A."\n"B."\n"C."';
    expect(findUnattributedDialogueRuns(three, { minRun: 3 })).toHaveLength(1);
  });

  it('pure narration with no quotes yields no runs', () => {
    expect(findUnattributedDialogueRuns('He walked. She followed. The road was long.')).toEqual([]);
  });

  it('returns [] for non-strings and empty input', () => {
    expect(findUnattributedDialogueRuns('')).toEqual([]);
    expect(findUnattributedDialogueRuns(null)).toEqual([]);
  });

  it('handles curly double quotes', () => {
    const curly = [
      '“You came back.”',
      '“I had to.”',
      '“After everything?”',
      '“Especially after everything.”',
      '“And now?”',
      '“Now we finish it.”',
    ].join('\n');
    expect(findUnattributedDialogueRuns(curly)).toHaveLength(1);
  });
});

describe('attributeDialogueByOwner', () => {
  // A whole-token matcher like the one checkRegistry builds (non-global).
  const owner = (key, ...tokens) => ({
    key,
    matcher: new RegExp(`(?<!\\w)(?:${tokens.join('|')})(?!\\w)`, 'i'),
  });

  it('credits a dialogue line to the owner named in the beat, not inside the quote', () => {
    // Discriminating: the quote names "Aria" but the BEAT names "Bram", and the
    // owner list is ordered [aria, bram] so first-match-wins favors the in-quote
    // name. Correct (beat-only) attribution credits Bram; a regression that
    // matched the whole paragraph (quote not stripped) would credit Aria — so
    // this assertion actually fails if the quote-strip is removed.
    const text = '"I saw Aria at the gate," said Bram.';
    const { byOwner, total, attributed, unattributed } = attributeDialogueByOwner(text, [
      owner('aria', 'Aria'),
      owner('bram', 'Bram'),
    ]);
    expect(total).toBe(1);
    expect(attributed).toBe(1);
    expect(unattributed).toBe(0);
    expect(byOwner.get('bram')).toBe(1);
    expect(byOwner.has('aria')).toBe(false);
  });

  it('counts a dialogue line with no resolvable speaker as unattributed', () => {
    const text = '"Who goes there?"\n"A friend," said Aria.';
    const { byOwner, total, attributed, unattributed } = attributeDialogueByOwner(text, [
      owner('aria', 'Aria'),
    ]);
    expect(total).toBe(2);
    expect(attributed).toBe(1);
    expect(unattributed).toBe(1);
    expect(byOwner.get('aria')).toBe(1);
  });

  it('credits the earliest-named character in the beat, independent of owner (canon) order', () => {
    // "Aria told Bram" — Aria is the speaker (leftmost name). The owner list is
    // ordered [bram, aria] (canon order) to prove attribution follows beat
    // POSITION, not list order: a position-blind first-in-list scan would
    // wrongly credit Bram.
    const text = '"Stop," Aria told Bram.';
    const { byOwner } = attributeDialogueByOwner(text, [
      owner('bram', 'Bram'),
      owner('aria', 'Aria'),
    ]);
    expect(byOwner.get('aria')).toBe(1);
    expect(byOwner.has('bram')).toBe(false);
  });

  it('ignores paragraphs with no quoted span (pure narration)', () => {
    const text = 'Aria walked the long road home.\n"Finally," she said.';
    const { total } = attributeDialogueByOwner(text, [owner('aria', 'Aria')]);
    expect(total).toBe(1);
  });

  it('returns an empty result for non-strings and empty input', () => {
    expect(attributeDialogueByOwner('', [owner('a', 'A')]).total).toBe(0);
    expect(attributeDialogueByOwner(null, [owner('a', 'A')]).total).toBe(0);
    const r = attributeDialogueByOwner('"Hi," said A.', []);
    expect(r.total).toBe(1);
    expect(r.unattributed).toBe(1);
  });

  it('tolerates malformed owner entries without throwing', () => {
    const text = '"Hi," said Aria.';
    expect(() => attributeDialogueByOwner(text, [null, { key: 'x' }, 'nope'])).not.toThrow();
    const { unattributed } = attributeDialogueByOwner(text, [null, { key: 'x' }]);
    expect(unattributed).toBe(1);
  });
});

describe('inventoryDialogueTags', () => {
  it('collapses inflections onto a base lemma (said/says → say)', () => {
    const tags = inventoryDialogueTags('"A," she said.\n"B," he says.');
    expect(tags.map((t) => t.verb)).toEqual(['say', 'say']);
  });

  it('inventories an ornate tag as its base alongside plain tags', () => {
    const tags = inventoryDialogueTags('"A," she said.\n"B," he opined.');
    expect(tags.map((t) => t.verb)).toEqual(['say', 'opine']);
  });

  it('excludes non-speech action "tags" (those are the said-bookisms scan\'s job)', () => {
    const tags = inventoryDialogueTags('"Of course," she smiled.');
    expect(tags).toHaveLength(0);
  });

  it('does not count a narrated verb with no adjacent quote', () => {
    expect(inventoryDialogueTags('The engine said nothing as it idled.')).toHaveLength(0);
  });

  it('does not count an action beat after a complete (period-terminated) line', () => {
    // "She added a log to the fire." is narration, not a tag — the quote ended on a period.
    expect(inventoryDialogueTags('"Done." She added a log to the fire.')).toHaveLength(0);
  });

  it('honors allowWords to mute a tag verb', () => {
    const tags = inventoryDialogueTags('"A," she said.\n"B," he asked.', { allowWords: ['say'] });
    expect(tags.map((t) => t.verb)).toEqual(['ask']);
  });
});

describe('splitScenes', () => {
  it('returns a single scene when there are no dividers', () => {
    const scenes = splitScenes('Line one.\nLine two.');
    expect(scenes).toHaveLength(1);
    expect(scenes[0].ordinal).toBe(1);
  });

  it('splits on a centered rule (***) and excludes the divider line', () => {
    const scenes = splitScenes('"A," she said.\n***\n"B," he said.');
    expect(scenes).toHaveLength(2);
    expect(scenes[0].text).toContain('A');
    expect(scenes[1].text).toContain('B');
    expect(scenes[1].ordinal).toBe(2);
  });

  it('splits on a markdown scene heading', () => {
    const scenes = splitScenes('First.\n## Scene 2\nSecond.');
    expect(scenes).toHaveLength(2);
  });

  it('keeps absolute offsets so a scene index maps back into the text', () => {
    const text = 'First.\n***\nSecond.';
    const scenes = splitScenes(text);
    expect(text.slice(scenes[1].index)).toContain('Second');
  });

  it('returns nothing for empty / non-string input', () => {
    expect(splitScenes('')).toEqual([]);
    expect(splitScenes(null)).toEqual([]);
  });
});

describe('findDialogueTagVariety', () => {
  const monotoneScene = Array.from({ length: 6 }, (_, i) => `"Line ${i}," she said.`).join('\n');

  it('flags within-scene monotony when one tag verb dominates', () => {
    const hits = findDialogueTagVariety(monotoneScene);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ type: 'monotony', verb: 'say', count: 6, total: 6, sceneOrdinal: 1 });
  });

  it('flags over-variation when nearly every tagged line uses a different verb', () => {
    const churn = [
      '"A," she said.',
      '"B," he asked.',
      '"C," she replied.',
      '"D," he whispered.',
      '"E," she murmured.',
      '"F," he shouted.',
    ].join('\n');
    const hits = findDialogueTagVariety(churn);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ type: 'over-variation', distinct: 6, total: 6 });
  });

  it('does not flag a scene with too few tags to judge', () => {
    expect(findDialogueTagVariety('"A," she said.\n"B," he said.')).toHaveLength(0);
  });

  it('does not flag a healthily varied, said-dominant scene', () => {
    // Mostly invisible "said" with a little variation — the craft target.
    const healthy = [
      '"A," she said.',
      '"B," he said.',
      '"C," she asked.',
      '"D," he said.',
      '"E," she replied.',
      '"F," he said.',
    ].join('\n');
    expect(findDialogueTagVariety(healthy)).toHaveLength(0);
  });

  it('judges each scene independently across a divider', () => {
    const text = `${monotoneScene}\n***\n"X," she said.\n"Y," he said.`;
    const hits = findDialogueTagVariety(text);
    // Only the first scene is monotone; the trailing 2-tag scene is too small.
    expect(hits).toHaveLength(1);
    expect(hits[0].sceneOrdinal).toBe(1);
  });

  it('respects monotonyCount/minTags overrides', () => {
    const text = Array.from({ length: 4 }, (_, i) => `"L${i}," she said.`).join('\n');
    expect(findDialogueTagVariety(text)).toHaveLength(0); // 4 tags < default minTags 6
    const hits = findDialogueTagVariety(text, { minTags: 4, monotonyCount: 4 });
    expect(hits).toHaveLength(1);
    expect(hits[0].type).toBe('monotony');
  });

  it('returns nothing for empty / non-string input', () => {
    expect(findDialogueTagVariety('')).toEqual([]);
    expect(findDialogueTagVariety(null)).toEqual([]);
  });
});
