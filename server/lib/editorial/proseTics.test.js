import { describe, it, expect } from 'vitest';
import {
  tokenizeWords,
  splitSentences,
  findFilterWords,
  findHedgeWords,
  findCrutchWords,
  findAdverbs,
  findPassiveVoice,
  filterPassiveVoice,
  findGestures,
  FILTER_WORDS,
  HEDGE_WORDS,
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

  it('flags modal-perception phrase additions ("could see", "found himself")', () => {
    const entries = findFilterWords('She could see the door; he found himself running.').map((h) => h.entry);
    expect(entries).toContain('could see');
    expect(entries).toContain('found himself');
  });

  it('seed list is frozen and lowercase', () => {
    expect(Object.isFrozen(FILTER_WORDS)).toBe(true);
    for (const w of FILTER_WORDS) expect(w).toBe(w.toLowerCase());
  });
});

describe('findHedgeWords', () => {
  it('flags metaphorical-distance, hedge, and weasel markers', () => {
    const entries = findHedgeWords(
      'It was as if he knew. Part of him almost felt it. I kind of think so, no doubt.',
    ).map((h) => h.entry);
    expect(entries).toContain('as if');
    expect(entries).toContain('part of him');
    expect(entries).toContain('almost');
    expect(entries).toContain('kind of');
    expect(entries).toContain('no doubt');
  });

  it('matches multi-word phrases whole, longest-first ("as if" not bare "if")', () => {
    const hits = findHedgeWords('She moved as if weightless.');
    expect(hits.map((h) => h.anchor.toLowerCase())).toContain('as if');
  });

  it('respects allowWords and extraWords', () => {
    expect(findHedgeWords('Almost there.', { allowWords: ['almost'] })).toEqual([]);
    const extra = findHedgeWords('It was basically fine.', { extraWords: ['basically'] });
    expect(extra.map((h) => h.entry)).toContain('basically');
  });

  it('does not match substrings (almsot/almost boundary)', () => {
    expect(findHedgeWords('The almshouse stood empty.')).toEqual([]);
  });

  it('seed list is frozen and lowercase', () => {
    expect(Object.isFrozen(HEDGE_WORDS)).toBe(true);
    for (const w of HEDGE_WORDS) expect(w).toBe(w.toLowerCase());
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

  it('flags non-ly adverbs supplied via extraWords', () => {
    // "fast" is a real adverb the -ly heuristic misses; the series can add it.
    expect(findAdverbs('She ran fast.')).toEqual([]);
    const hits = findAdverbs('She ran fast.', { extraWords: ['fast'] });
    expect(hits.map((h) => h.word.toLowerCase())).toContain('fast');
  });

  it('allowWords still wins over an extraWords entry', () => {
    const hits = findAdverbs('She ran fast.', { extraWords: ['fast'], allowWords: ['fast'] });
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

  it('classifies an agentive passive as weak', () => {
    const [hit] = findPassiveVoice('The door was opened by Sam.');
    expect(hit.classification).toBe('weak');
    expect(hit.byAgent).toBe(true);
  });

  it('classifies a predicate-adjective state as stative', () => {
    const [hit] = findPassiveVoice('She was exhausted.');
    expect(hit.classification).toBe('stative');
    expect(hit.byAgent).toBe(false);
  });

  it('classifies a setting/weather subject as mood', () => {
    const [hit] = findPassiveVoice('The sky was streaked with red.');
    expect(hit.classification).toBe('mood');
  });

  it('an explicit "by <agent>" overrides a stative participle to weak', () => {
    const [hit] = findPassiveVoice('She was exhausted by the climb.');
    expect(hit.byAgent).toBe(true);
    expect(hit.classification).toBe('weak');
  });

  it('detects a "by <agent>" with an intervening adverb', () => {
    const [hit] = findPassiveVoice('The room was decorated elaborately by Mira.');
    expect(hit.byAgent).toBe(true);
    expect(hit.classification).toBe('weak');
  });

  it('keeps an action passive with a setting subject as weak (no atmospheric participle)', () => {
    expect(findPassiveVoice('The room was searched.')[0].classification).toBe('weak');
    // A "with"/"in" complement on a non-atmospheric verb must not read as mood.
    expect(findPassiveVoice('The room was searched with dogs.')[0].classification).toBe('weak');
    expect(findPassiveVoice('The city was attacked in winter.')[0].classification).toBe('weak');
  });

  it('does not treat a "by <time>" phrase as an agent', () => {
    const [hit] = findPassiveVoice('She was exhausted by morning.');
    expect(hit.byAgent).toBe(false);
    expect(hit.classification).toBe('stative');
  });

  it('skips a determiner to spot a "by the <time>" phrase', () => {
    const [hit] = findPassiveVoice('She was exhausted by the morning.');
    expect(hit.byAgent).toBe(false);
    expect(hit.classification).toBe('stative');
  });

  it('still treats "by the <agent>" as a real agent', () => {
    const [hit] = findPassiveVoice('She was exhausted by the climb.');
    expect(hit.byAgent).toBe(true);
    expect(hit.classification).toBe('weak');
  });

  it('does not read a "by" from the next sentence as the agent', () => {
    // "By morning" starts a new sentence — it must not flip the stative
    // "was exhausted" into a weak by-agent passive.
    const [hit] = findPassiveVoice('She was exhausted. By morning the fog had lifted.');
    expect(hit.byAgent).toBe(false);
    expect(hit.classification).toBe('stative');
  });

  it('mutes an allow-listed participle (archaic/adjectival -ed form)', () => {
    // "blessed" trips the bare -ed heuristic; a series can allow-list it.
    expect(findPassiveVoice('She was blessed.').map((h) => h.participle)).toContain('blessed');
    expect(findPassiveVoice('She was blessed.', { allowWords: ['blessed'] })).toEqual([]);
  });

  it('recognizes a series-specific irregular participle via extraWords', () => {
    // "hewn" is an irregular participle the -ed/known-irregular heuristic misses.
    expect(findPassiveVoice('The beam was hewn from oak.')).toEqual([]);
    const hits = findPassiveVoice('The beam was hewn from oak.', { extraWords: ['hewn'] });
    expect(hits.map((h) => h.participle)).toContain('hewn');
  });

  it('allowWords wins over extraWords for participle recognition', () => {
    const hits = findPassiveVoice('The beam was hewn.', { extraWords: ['hewn'], allowWords: ['hewn'] });
    expect(hits).toEqual([]);
  });
});

describe('filterPassiveVoice', () => {
  const text = 'The door was opened by Sam. She was exhausted. The sky was streaked with red.';

  it('keeps only weak passive by default (drops stative + mood)', () => {
    const kept = filterPassiveVoice(findPassiveVoice(text));
    expect(kept.map((h) => h.classification)).toEqual(['weak']);
  });

  it('keeps every candidate when suppressIntentional is off (raw heuristic)', () => {
    const kept = filterPassiveVoice(findPassiveVoice(text), { suppressIntentional: false });
    expect(kept.length).toBe(3);
  });

  it('tolerates a non-array input', () => {
    expect(filterPassiveVoice(null)).toEqual([]);
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
