import { describe, it, expect } from 'vitest';
import {
  findSaidBookisms,
  findUnattributedDialogueRuns,
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
