import { describe, it, expect } from 'vitest';
import {
  tokenizeWords,
  splitSentences,
  findFilterWords,
  findCrutchWords,
  findAdverbs,
  findPassiveVoice,
  findGestures,
  FILTER_WORDS,
  CRUTCH_WORDS,
} from './proseTics.js';

describe('tokenizeWords', () => {
  it('keeps apostrophes inside contractions and records offsets', () => {
    const toks = tokenizeWords("She couldn't go.");
    expect(toks.map((t) => t.word)).toEqual(['She', "couldn't", 'go']);
    expect(toks[0].index).toBe(0);
    expect(toks[1].lower).toBe("couldn't");
  });

  it('returns [] for non-strings and empties', () => {
    expect(tokenizeWords('')).toEqual([]);
    expect(tokenizeWords(null)).toEqual([]);
    expect(tokenizeWords(42)).toEqual([]);
  });
});

describe('splitSentences', () => {
  it('splits on sentence-ending punctuation and anchors at the first non-space char', () => {
    const text = 'One. Two! Three?';
    const s = splitSentences(text);
    expect(s.map((x) => x.text)).toEqual(['One.', 'Two!', 'Three?']);
    expect(text.slice(s[1].index, s[1].index + 4)).toBe('Two!');
  });

  it('ignores whitespace-only spans', () => {
    expect(splitSentences('   ')).toEqual([]);
  });
});

describe('findFilterWords', () => {
  it('flags distancing verbs and phrase entries', () => {
    const hits = findFilterWords('She saw the door and began to run.');
    const entries = hits.map((h) => h.entry);
    expect(entries).toContain('saw');
    expect(entries).toContain('began to');
  });

  it('matches "began to" as a whole phrase (longest-first), not bare "began"', () => {
    const hits = findFilterWords('He began to move.');
    expect(hits.map((h) => h.anchor.toLowerCase())).toContain('began to');
  });

  it('respects allowWords and extraWords', () => {
    expect(findFilterWords('She saw it.', { allowWords: ['saw'] })).toEqual([]);
    const extra = findFilterWords('She gazed at it.', { extraWords: ['gazed'] });
    expect(extra.map((h) => h.entry)).toContain('gazed');
  });

  it('does not match substrings (sawmill ≠ saw)', () => {
    expect(findFilterWords('The sawmill was loud.')).toEqual([]);
  });

  it('seed list is frozen and lowercase', () => {
    expect(Object.isFrozen(FILTER_WORDS)).toBe(true);
    for (const w of FILTER_WORDS) expect(w).toBe(w.toLowerCase());
  });
});

describe('findCrutchWords', () => {
  it('flags intensifiers but excludes bare "that" by default', () => {
    const hits = findCrutchWords('It was just really very that thing.');
    const entries = hits.map((h) => h.entry);
    expect(entries).toEqual(expect.arrayContaining(['just', 'really', 'very']));
    expect(entries).not.toContain('that');
  });

  it('includes "that" only when includeThat is set', () => {
    const hits = findCrutchWords('the book that he read', { includeThat: true });
    expect(hits.map((h) => h.entry)).toContain('that');
  });

  it('matches "in order to" as a phrase', () => {
    const hits = findCrutchWords('He left in order to escape.');
    expect(hits.map((h) => h.entry)).toContain('in order to');
  });

  it('CRUTCH_WORDS omits bare "that"', () => {
    expect(CRUTCH_WORDS).not.toContain('that');
  });
});

describe('findAdverbs', () => {
  it('flags -ly adverbs and skips non-adverb -ly words', () => {
    const hits = findAdverbs('She quickly entered the family home only briefly.');
    const words = hits.map((h) => h.word.toLowerCase());
    expect(words).toContain('quickly');
    expect(words).toContain('briefly');
    expect(words).not.toContain('family'); // not an adverb
    expect(words).not.toContain('only');    // excluded
  });

  it('marks dialogue-tag adverbs and classifies an emotion tell', () => {
    const hits = findAdverbs('"Fine," she said angrily.');
    const tag = hits.find((h) => h.word.toLowerCase() === 'angrily');
    expect(tag).toBeTruthy();
    expect(tag.dialogueTag).toBe(true);
    expect(tag.tagAdverbKind).toBe('emotion');
  });

  it('classifies a reporting tag adverb (manner/volume) as reporting', () => {
    const hits = findAdverbs('"Fine," she said quietly.');
    const tag = hits.find((h) => h.word.toLowerCase() === 'quietly');
    expect(tag.dialogueTag).toBe(true);
    expect(tag.tagAdverbKind).toBe('reporting');
  });

  it('does not mark a non-tag-preceded adverb as a dialogue tag', () => {
    const hits = findAdverbs('She walked slowly.');
    expect(hits[0].dialogueTag).toBe(false);
    expect(hits[0].tagAdverbKind).toBe(null);
  });

  it('respects allowWords', () => {
    const hits = findAdverbs('She ran quickly.', { allowWords: ['quickly'] });
    expect(hits).toEqual([]);
  });
});

describe('findPassiveVoice', () => {
  it('flags be-verb + past participle', () => {
    const hits = findPassiveVoice('The door was opened by Sam.');
    expect(hits.length).toBe(1);
    expect(hits[0].be).toBe('was');
    expect(hits[0].participle).toBe('opened');
  });

  it('flags irregular participles', () => {
    const hits = findPassiveVoice('The vase was broken.');
    expect(hits.map((h) => h.participle)).toContain('broken');
  });

  it('allows an intervening adverb', () => {
    const hits = findPassiveVoice('It was quietly forgotten.');
    expect(hits.length).toBe(1);
    expect(hits[0].participle).toBe('forgotten');
  });

  it('does not flag a be-verb with no participle', () => {
    expect(findPassiveVoice('She was happy.')).toEqual([]);
  });
});

describe('findGestures', () => {
  it('tallies gesture verbs across inflections', () => {
    const { gestures } = findGestures('He nodded. She nods. They were nodding.');
    expect(gestures.every((g) => g.base === 'nod')).toBe(true);
    expect(gestures.length).toBe(3);
  });

  it('flags body-part autonomy', () => {
    const { bodyParts } = findGestures('Her eyes followed him across the room.');
    expect(bodyParts.length).toBe(1);
    expect(bodyParts[0].anchor.toLowerCase()).toContain('eyes followed');
  });

  it('respects allowWords for gestures', () => {
    const { gestures } = findGestures('He smiled.', { allowWords: ['smile'] });
    expect(gestures).toEqual([]);
  });

  it('returns empty shape for empty text', () => {
    expect(findGestures('')).toEqual({ gestures: [], bodyParts: [] });
  });
});
