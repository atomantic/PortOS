import { describe, it, expect } from 'vitest';
import {
  TIER1_BANNED_WORDS,
  TIER2_SUSPICIOUS_WORDS,
  AI_TELL_PATTERNS,
  TRANSITION_OPENERS,
  SLOP_PENALTY_WEIGHTS,
  findBannedWordsTier1,
  findSuspiciousWordClusters,
  splitParagraphs,
  findAiTells,
  findNotJustButPatterns,
  findNotSayingPatterns,
  findNegativeAssertions,
  findTheWaySimiles,
  findTriadicShortSentences,
  findStructuralTics,
  emDashDensityPer1000,
  transitionOpenerRatio,
  paragraphLengthUniformity,
  countSectionBreaks,
  computeSlopPenalty,
} from './slopScore.js';

describe('findBannedWordsTier1', () => {
  it('flags every occurrence of a Tier 1 word (not deduped)', () => {
    const text = 'She would delve into the archive. Later, she delved again.';
    const hits = findBannedWordsTier1(text);
    expect(hits).toHaveLength(2);
    expect(hits[0].entry).toBe('delve');
    expect(hits[1].entry).toBe('delved');
  });

  it('matches multi-word and hyphenated seed phrases with flexible spacing', () => {
    expect(findBannedWordsTier1('This is an ever-evolving landscape.')).toHaveLength(1);
    expect(findBannedWordsTier1('This is an ever evolving landscape.')).toHaveLength(1);
    expect(findBannedWordsTier1('It stands as a testament to her will.')).toHaveLength(1);
  });

  it('respects allowWords and extraWords', () => {
    expect(findBannedWordsTier1('She would delve into it.', { allowWords: ['delve'] })).toHaveLength(0);
    expect(findBannedWordsTier1('A truly bespoke solution.', { extraWords: ['bespoke'] })).toHaveLength(1);
  });

  it('does not flag ordinary prose', () => {
    expect(findBannedWordsTier1('She opened the door and stepped inside.')).toHaveLength(0);
  });

  it('has no overlap with the Tier 2 suspicious list', () => {
    const tier1 = new Set(TIER1_BANNED_WORDS.map((w) => w.toLowerCase()));
    for (const w of TIER2_SUSPICIOUS_WORDS) {
      expect(tier1.has(w.toLowerCase())).toBe(false);
    }
  });
});

describe('splitParagraphs', () => {
  it('splits on blank lines and reports absolute offsets', () => {
    const text = 'First paragraph.\n\nSecond paragraph.\n\nThird.';
    const paras = splitParagraphs(text);
    expect(paras.map((p) => p.text)).toEqual(['First paragraph.', 'Second paragraph.', 'Third.']);
    for (const p of paras) {
      expect(text.slice(p.index, p.index + p.text.length)).toBe(p.text);
    }
  });
});

describe('findSuspiciousWordClusters', () => {
  it('does NOT flag an isolated Tier 2 word', () => {
    const text = 'The plan was robust, but nothing else in this paragraph is suspicious.';
    expect(findSuspiciousWordClusters(text)).toHaveLength(0);
  });

  it('flags a cluster of 3+ Tier 2 words within one paragraph', () => {
    const text = 'The robust plan fostered a seamless transition, and it felt pivotal to the whole effort.';
    const clusters = findSuspiciousWordClusters(text);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].count).toBeGreaterThanOrEqual(3);
    expect(clusters[0].words).toEqual(expect.arrayContaining(['robust', 'fostered', 'seamless', 'pivotal']));
  });

  it('isolated vs. clustered Tier 2 words in different paragraphs of the same text', () => {
    const text = [
      'The robust plan fostered a seamless transition that felt pivotal.',
      '',
      'Meanwhile, the weather was merely pleasant that day.',
    ].join('\n');
    const clusters = findSuspiciousWordClusters(text);
    expect(clusters).toHaveLength(1);
  });

  it('honors a custom clusterThreshold', () => {
    const text = 'The plan was robust and seamless.';
    expect(findSuspiciousWordClusters(text, { clusterThreshold: 3 })).toHaveLength(0);
    expect(findSuspiciousWordClusters(text, { clusterThreshold: 2 })).toHaveLength(1);
  });
});

describe('findAiTells', () => {
  it('flags each fiction AI-tell idiom', () => {
    const fixtures = {
      'sense-of': 'A sense of dread settled over the room.',
      'couldnt-help-but': "She couldn't help but smile at the memory.",
      'eyes-widened': 'His eyes widened at the sight.',
      'breath-didnt-know': "She let out a breath she didn't know she'd been holding.",
      'wave-of-emotion': 'A wave of relief washed over him.',
      'heart-pounded-chest': 'Her heart pounded in her chest as the door creaked open.',
      'physical-named-emotion': 'Her heart raced with fear as the shadow moved.',
    };
    for (const [id, text] of Object.entries(fixtures)) {
      const hits = findAiTells(text);
      expect(hits.map((h) => h.id), `expected pattern "${id}" to fire on: ${text}`).toContain(id);
    }
  });

  it('reports one finding per distinct pattern (first occurrence only)', () => {
    const text = 'His eyes widened. Moments later her eyes widened too.';
    const hits = findAiTells(text);
    expect(hits.filter((h) => h.id === 'eyes-widened')).toHaveLength(1);
  });

  it('respects allowPatterns', () => {
    const text = 'His eyes widened at the sight.';
    expect(findAiTells(text, { allowPatterns: ['eyes-widened'] })).toHaveLength(0);
  });

  it('does not flag clean prose', () => {
    expect(findAiTells('The door creaked open and she stepped through.')).toHaveLength(0);
  });

  it('"couldn\'t help but" matches the typographic curly apostrophe too', () => {
    // ’ is the curly apostrophe Word/Scrivener/Google Docs auto-substitute.
    const hits = findAiTells('She couldn’t help but smile at the memory.');
    expect(hits.map((h) => h.id)).toContain('couldnt-help-but');
  });

  it('every pattern declares a unique id', () => {
    const ids = AI_TELL_PATTERNS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('findNotJustButPatterns', () => {
  it('flags the "not just X, but Y" construction', () => {
    const text = 'It was not just a house, but a home to three generations.';
    const hits = findNotJustButPatterns(text);
    expect(hits).toHaveLength(1);
    expect(hits[0].anchor).toMatch(/not just a house, but a home/i);
  });

  it('flags "not only ... but also"', () => {
    const text = 'The plan was not only ambitious, but also dangerous.';
    expect(findNotJustButPatterns(text)).toHaveLength(1);
  });

  it('does not flag ordinary negation', () => {
    expect(findNotJustButPatterns('She did not want to leave the house tonight.')).toHaveLength(0);
  });
});

describe('findNotSayingPatterns', () => {
  it('flags "I\'m not saying X, I\'m saying Y"', () => {
    const text = "I'm not saying he's guilty, I'm saying the evidence is thin.";
    expect(findNotSayingPatterns(text)).toHaveLength(1);
  });

  it('does not flag a lone "I\'m not saying" clause', () => {
    expect(findNotSayingPatterns("I'm not saying anything else about it tonight.")).toHaveLength(0);
  });

  it('matches typographic curly apostrophes too (word-processor manuscripts)', () => {
    // ’ is the curly apostrophe Word/Scrivener/Google Docs auto-substitute.
    const text = 'I’m not saying he’s guilty, I’m saying the evidence is thin.';
    expect(findNotSayingPatterns(text)).toHaveLength(1);
  });
});

describe('findNegativeAssertions', () => {
  it('matches "did not [verb]" and contracted forms', () => {
    const text = 'She did not flinch. He did not move. They didn\'t speak. It doesn\'t matter.';
    const hits = findNegativeAssertions(text);
    expect(hits.length).toBe(4);
  });

  it('returns nothing for text with no negative assertions', () => {
    expect(findNegativeAssertions('She smiled and walked away.')).toHaveLength(0);
  });

  it('matches typographic curly apostrophes too (word-processor manuscripts)', () => {
    const text = 'They didn’t speak. It doesn’t matter.';
    expect(findNegativeAssertions(text)).toHaveLength(2);
  });
});

describe('findTheWaySimiles', () => {
  it('flags "the way [subject] [verb]" constructions', () => {
    const text = 'He loved the way her voice cracked when she laughed.';
    expect(findTheWaySimiles(text).length).toBeGreaterThanOrEqual(1);
  });

  it('does not flag an unrelated use of "the way"', () => {
    expect(findTheWaySimiles('Which way should we go from here?')).toHaveLength(0);
  });
});

describe('findTriadicShortSentences', () => {
  it('flags 3+ consecutive very short sentences', () => {
    const text = 'Fast. Precise. Deadly. That was the whole plan from the very beginning.';
    const hits = findTriadicShortSentences(text);
    expect(hits).toHaveLength(1);
    expect(hits[0].count).toBe(3);
  });

  it('does not flag two short sentences (below minRun)', () => {
    const text = 'Fast. Precise. That was the whole elaborate and carefully considered plan.';
    expect(findTriadicShortSentences(text)).toHaveLength(0);
  });

  it('does not flag normal-length sentences', () => {
    const text = 'She walked across the room slowly. He watched her every movement. Neither spoke a word for a long while.';
    expect(findTriadicShortSentences(text)).toHaveLength(0);
  });

  it('honors a custom minRun', () => {
    const text = 'Fast. Precise. Deadly. Quiet. That was the plan they settled on eventually.';
    expect(findTriadicShortSentences(text, { minRun: 5 })).toHaveLength(0);
    expect(findTriadicShortSentences(text, { minRun: 4 })).toHaveLength(1);
  });
});

describe('findStructuralTics', () => {
  it('merges all four pattern types, position-ordered', () => {
    const text = [
      'Fast. Precise. Deadly.',
      'It was not just brave, but reckless.',
      'He loved the way she carried herself into the room.',
    ].join(' ');
    const hits = findStructuralTics(text);
    const types = hits.map((h) => h.type);
    expect(types).toContain('triadic-short-sentences');
    expect(types).toContain('not-just-but');
    expect(types).toContain('the-way-simile');
    // Position-ordered.
    for (let i = 1; i < hits.length; i += 1) {
      expect(hits[i].index).toBeGreaterThanOrEqual(hits[i - 1].index);
    }
  });

  it('gates negative-assertion density below the threshold (no finding)', () => {
    // A single "did not" in a long passage sits well under the default
    // 4-per-1000-words threshold.
    const filler = 'word '.repeat(300);
    const text = `${filler}She did not flinch. ${filler}`;
    const tics = findStructuralTics(text);
    expect(tics.find((t) => t.type === 'negative-assertion-density')).toBeUndefined();
  });

  it('reports negative-assertion density once the rate crosses the threshold', () => {
    const text = 'She did not flinch. He did not move. They did not speak. It did not matter. Nothing did not change.';
    const tics = findStructuralTics(text);
    const found = tics.find((t) => t.type === 'negative-assertion-density');
    expect(found).toBeDefined();
    expect(found.count).toBeGreaterThanOrEqual(4);
  });

  it('returns an empty array for clean prose', () => {
    expect(findStructuralTics('She opened the door and stepped inside, unsure of what she would find.')).toHaveLength(0);
  });
});

describe('emDashDensityPer1000', () => {
  it('hand-computes the rate from a known word/em-dash count', () => {
    // 10 words, 2 em dashes -> 200 per 1000.
    const text = 'one two three — four five — six seven eight nine ten';
    const result = emDashDensityPer1000(text);
    expect(result.words).toBe(10);
    expect(result.count).toBe(2);
    expect(result.rate).toBe(200);
  });

  it('returns zeros for text with no em dashes', () => {
    const result = emDashDensityPer1000('one two three four five');
    expect(result.count).toBe(0);
    expect(result.rate).toBe(0);
  });
});

describe('transitionOpenerRatio', () => {
  it('hand-computes the ratio from known sentence openers', () => {
    // 4 sentences, 2 open with a transition word -> ratio 0.5.
    const text = 'However, the weather turned. She walked home anyway. Moreover, she smiled. He waved back at her.';
    const result = transitionOpenerRatio(text);
    expect(result.total).toBe(4);
    expect(result.count).toBe(2);
    expect(result.ratio).toBe(0.5);
  });

  it('returns a zero ratio when no sentence opens with a transition word', () => {
    const text = 'She walked home. He waved back. They smiled.';
    const result = transitionOpenerRatio(text);
    expect(result.count).toBe(0);
    expect(result.ratio).toBe(0);
  });
});

describe('paragraphLengthUniformity', () => {
  it('flags 3+ consecutive paragraphs of near-identical word count', () => {
    const para = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
    const text = [para(10), para(10), para(11), para(10)].join('\n\n');
    const runs = paragraphLengthUniformity(text);
    expect(runs).toHaveLength(1);
    expect(runs[0].count).toBe(4);
  });

  it('does not flag paragraphs of widely varying length', () => {
    const para = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
    const text = [para(5), para(40), para(8), para(60)].join('\n\n');
    expect(paragraphLengthUniformity(text)).toHaveLength(0);
  });

  it('is a no-op below minRun paragraphs', () => {
    const para = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
    const text = [para(10), para(10)].join('\n\n');
    expect(paragraphLengthUniformity(text)).toHaveLength(0);
  });
});

describe('countSectionBreaks', () => {
  it('counts common scene-break marker lines', () => {
    const text = [
      'Some prose.',
      '***',
      'More prose.',
      '---',
      'Even more prose.',
      '* * *',
    ].join('\n');
    expect(countSectionBreaks(text)).toBe(3);
  });

  it('does not count a line that merely contains punctuation among prose', () => {
    expect(countSectionBreaks('She said - "wait" - and stopped.')).toBe(0);
  });

  it('returns 0 for text with no markers', () => {
    expect(countSectionBreaks('Just plain prose with no breaks at all.')).toBe(0);
  });
});

describe('computeSlopPenalty', () => {
  it('returns 0 for empty/non-string input', () => {
    expect(computeSlopPenalty('')).toBe(0);
    expect(computeSlopPenalty('   ')).toBe(0);
    expect(computeSlopPenalty(null)).toBe(0);
    expect(computeSlopPenalty(undefined)).toBe(0);
  });

  it('returns 0 for clean, varied human-style prose', () => {
    const text = [
      'Mira set the cup down and looked out the window.',
      'Rain traced slow lines down the glass, and somewhere below a dog barked twice, then quit.',
      'She thought about calling him.',
      'She didn\'t.',
    ].join(' ');
    expect(computeSlopPenalty(text)).toBe(0);
  });

  it('clamps the Tier 1 contribution at the documented cap', () => {
    const repeated = 'delve '.repeat(50); // far more hits than tier1Cap / tier1PerHit
    const penalty = computeSlopPenalty(repeated);
    expect(penalty).toBeLessThanOrEqual(SLOP_PENALTY_WEIGHTS.tier1Cap + 0.01);
  });

  it('adds the section-break penalty for an over-fragmented rate of scene breaks', () => {
    // 40 words total (two 20-word paragraphs), 1 section-break line -> 25/1000
    // words, far above the default 8/1000 threshold. Regression test:
    // computeSlopPenalty must actually fold in countSectionBreaks (previously
    // documented but not wired — caught in review).
    const prose = Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ');
    const text = [prose, '***', prose].join('\n');
    const penalty = computeSlopPenalty(text);
    expect(penalty).toBeGreaterThanOrEqual(SLOP_PENALTY_WEIGHTS.sectionBreakPenalty);
  });

  it('never exceeds 10 even for an adversarially slop-heavy passage', () => {
    const adversarial = [
      TIER1_BANNED_WORDS.join(' '),
      TIER2_SUSPICIOUS_WORDS.join(' '),
      ...AI_TELL_PATTERNS.map((p) => p.re.source), // not real matches, just bulk text
      'It was not just brave, but reckless. It was not just brave, but reckless.',
      'Fast. Precise. Deadly. Fast. Precise. Deadly.',
      'She did not flinch. He did not move. They did not speak. It did not matter.',
      '— '.repeat(100),
      TRANSITION_OPENERS.map((t) => `${t}, it happened again.`).join(' '),
    ].join(' ');
    const penalty = computeSlopPenalty(adversarial);
    expect(penalty).toBeLessThanOrEqual(10);
    expect(penalty).toBeGreaterThan(0);
  });

  it('adds the low-sentence-CV penalty for hand-computed monotonous sentence lengths', () => {
    // 8 sentences of EXACTLY 6 words each -> stddev 0, cv 0 (< 0.3 threshold).
    const sentence = (n) => `word${n} word word word word word.`;
    const text = Array.from({ length: 8 }, (_, i) => sentence(i)).join(' ');
    const penalty = computeSlopPenalty(text);
    expect(penalty).toBeGreaterThanOrEqual(SLOP_PENALTY_WEIGHTS.lowSentenceCvPenalty);
  });

  it('honors overridden weights', () => {
    const repeated = 'delve delve delve';
    const withDefault = computeSlopPenalty(repeated);
    const withOverride = computeSlopPenalty(repeated, { weights: { tier1PerHit: 0, tier1Cap: 0 } });
    expect(withOverride).toBeLessThan(withDefault);
  });
});
