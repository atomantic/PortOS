import { describe, it, expect } from 'vitest';
import {
  normalizeName,
  vowelSkeleton,
  soundex,
  levenshtein,
  analyzeNamePair,
  nameSimilaritySignals,
  firstLetterHistogram,
  findFirstLetterClusters,
} from './nameSimilarity.js';

describe('normalizeName', () => {
  it('lowercases and strips non-letters', () => {
    expect(normalizeName("O'Brien")).toBe('obrien');
    expect(normalizeName('Anne-Marie')).toBe('annemarie');
    expect(normalizeName('  Zoë 3 ')).toBe('zo'); // diacritics + digits dropped
  });
  it('tolerates empty / nullish input', () => {
    expect(normalizeName('')).toBe('');
    expect(normalizeName(null)).toBe('');
    expect(normalizeName(undefined)).toBe('');
  });
});

describe('vowelSkeleton', () => {
  it('keeps only the ordered vowels', () => {
    expect(vowelSkeleton('Rachel')).toBe('ae');
    expect(vowelSkeleton('Blake')).toBe('ae');
    expect(vowelSkeleton('Jane')).toBe('ae');
    expect(vowelSkeleton('Zog')).toBe('o');
  });
  it('returns empty when there are no vowels', () => {
    expect(vowelSkeleton('Bryn')).toBe('');
  });
});

describe('soundex', () => {
  it('matches known classic Soundex codes', () => {
    expect(soundex('Robert')).toBe('R163');
    expect(soundex('Rupert')).toBe('R163');
    expect(soundex('Smith')).toBe('S530');
    expect(soundex('Smyth')).toBe('S530');
    expect(soundex('Tymczak')).toBe('T522'); // vowel 'a' separates Z and K, so K is coded
    expect(soundex('Pfister')).toBe('P236'); // adjacent same-code (p/f) collapses
    expect(soundex('Ashcraft')).toBe('A261'); // h is transparent: s/c (both 2) stay one digit
  });
  it('pads short names to four chars', () => {
    expect(soundex('Sam')).toBe('S500');
    expect(soundex('Sun')).toBe('S500'); // Sam and Sun share a phonetic key
    expect(soundex('Lee')).toBe('L000');
  });
  it('returns empty for letterless input so it never collides', () => {
    expect(soundex('')).toBe('');
    expect(soundex('123')).toBe('');
  });
});

describe('levenshtein', () => {
  it('counts single-character edits on the normalized form', () => {
    expect(levenshtein('Alina', 'Alana')).toBe(1); // one substitution
    expect(levenshtein('John', 'Jon')).toBe(1); // one deletion
    expect(levenshtein('Sam', 'Sun')).toBe(2); // two substitutions
    expect(levenshtein('kitten', 'sitting')).toBe(3);
  });
  it('is zero for equal (normalized) names and handles empties', () => {
    expect(levenshtein('Bo', 'bo')).toBe(0);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
  });
});

describe('nameSimilaritySignals', () => {
  it('detects each signal type', () => {
    expect(nameSimilaritySignals('Sam', 'Sid')).toContain('same first letter');
    expect(nameSimilaritySignals('Sam', 'Tom', { vowelSkeletonCollision: false })).toContain('same length');
    expect(nameSimilaritySignals('Blake', 'Jane')).toContain('same vowel pattern');
    expect(nameSimilaritySignals('Marcus', 'Marvin')).toContain('same opening'); // "mar"
    expect(nameSimilaritySignals('Brian', 'Ian')).toContain('same ending'); // "an"
    expect(nameSimilaritySignals('Alina', 'Alana')).toContain('near-identical spelling (edit distance 1)');
    expect(nameSimilaritySignals('Smith', 'Smyth')).toContain('same phonetic key');
  });

  it('returns no signals for clearly distinct names', () => {
    expect(nameSimilaritySignals('Zog', 'Bree')).toEqual([]);
  });

  it('never emits both "same first letter" and "same opening" (no double-count)', () => {
    // A shared 3-char opening strictly implies a shared first letter — counting
    // both would double-count one similarity and trip the 2-signal gate on a
    // mere shared prefix. The more specific "same opening" wins; first-letter is
    // suppressed.
    const sig = nameSimilaritySignals('Marcus', 'Marvin');
    expect(sig).toContain('same opening');
    expect(sig).not.toContain('same first letter');
    // A shared first letter WITHOUT a shared 3-opening still reports first-letter.
    expect(nameSimilaritySignals('Sam', 'Sid')).toContain('same first letter');
  });

  it('treats a singular/plural variant of the same noun as inert (not a near-typo)', () => {
    // "readers"/"a reader", "poets"/"a poet", "waiter"/"waiters" are deliberate
    // count distinctions a reader parses effortlessly — they must NOT flag (and
    // especially must not escalate to high via the edit-distance-1 rule).
    expect(nameSimilaritySignals('readers', 'a reader')).toEqual([]);
    expect(nameSimilaritySignals('THE POET', 'poets')).toEqual([]);
    expect(nameSimilaritySignals('a waiter', 'THE WAITERS')).toEqual([]);
    expect(nameSimilaritySignals('city', 'cities')).toEqual([]);
    expect(analyzeNamePair('readers', 'reader')).toEqual({ signals: [], distance: Infinity, phoneticMatch: false });
    // `-es` plurals collapse only after a sibilant (box/boxes, church/churches).
    expect(nameSimilaritySignals('box', 'boxes')).toEqual([]);
    expect(nameSimilaritySignals('church', 'churches')).toEqual([]);
    // A SINGULAR name ending in non-sibilant + "es" (James, Charles) must NOT be
    // over-stemmed to "jam"/"charl" and false-collapsed onto a short name.
    expect(nameSimilaritySignals('James', 'Jam')).not.toEqual([]);
    // But two DIFFERENT words that merely both end in "s" are not a plural pair —
    // genuine confusability signals still apply.
    expect(nameSimilaritySignals('Marcus', 'Atlas')).not.toContain('near-identical spelling (edit distance 1)');
    expect(nameSimilaritySignals('Alina', 'Alana')).toContain('near-identical spelling (edit distance 1)');
  });

  it('strips a leading article before comparing (epithet casts)', () => {
    // "THE CABARET SINGER" vs "THE CHAPTER SEVENTEEN READER" must NOT collide on
    // the shared "THE" — compared on "cabaret…" / "chapter…" they share only a
    // first letter, not the article-driven opening, so they no longer auto-flag.
    const sig = nameSimilaritySignals('THE CABARET SINGER', 'THE CHAPTER SEVENTEEN READER');
    expect(sig).not.toContain('same opening');
    // Two epithet names that reduce to the same word are inert (equal forms).
    expect(nameSimilaritySignals('the reader', 'a reader')).toEqual([]);
  });

  it('returns no signals when a name has no letters or names are equal', () => {
    expect(nameSimilaritySignals('', 'Sam')).toEqual([]);
    expect(nameSimilaritySignals('Sam', 'sam')).toEqual([]);
  });

  it('honors the option toggles', () => {
    // flagSameLength off removes the length signal (Sam/Tim are both length 3)
    expect(nameSimilaritySignals('Sam', 'Tim')).toContain('same length');
    expect(nameSimilaritySignals('Sam', 'Tim', { flagSameLength: false })).not.toContain('same length');
    // vowelSkeletonCollision off removes the vowel signal
    expect(nameSimilaritySignals('Blake', 'Jane', { vowelSkeletonCollision: false })).not.toContain('same vowel pattern');
    // usePhonetic off removes the phonetic signal
    expect(nameSimilaritySignals('Smith', 'Smyth', { usePhonetic: false })).not.toContain('same phonetic key');
    // minEditDistance 0 disables the edit-distance signal
    expect(nameSimilaritySignals('Alina', 'Alana', { minEditDistance: 0 }))
      .not.toContain('near-identical spelling (edit distance 1)');
  });
});

describe('analyzeNamePair', () => {
  it('returns signals plus the severity metrics in one pass', () => {
    const r = analyzeNamePair('Alina', 'Alana');
    expect(r.distance).toBe(1);
    expect(r.phoneticMatch).toBe(true); // both Soundex A450
    expect(r.signals).toContain('near-identical spelling (edit distance 1)');
    expect(nameSimilaritySignals('Alina', 'Alana')).toEqual(r.signals); // wrapper agrees
  });

  it('reports no phonetic match when usePhonetic is off, and Infinity distance is harmless', () => {
    const r = analyzeNamePair('Smith', 'Smyth', { usePhonetic: false });
    expect(r.phoneticMatch).toBe(false);
    expect(r.signals).not.toContain('same phonetic key');
  });

  it('is inert for letterless / equal names', () => {
    expect(analyzeNamePair('', 'Sam')).toEqual({ signals: [], distance: Infinity, phoneticMatch: false });
    expect(analyzeNamePair('Sam', 'sam')).toEqual({ signals: [], distance: Infinity, phoneticMatch: false });
  });
});

describe('firstLetterHistogram', () => {
  it('buckets names by their first normalized letter', () => {
    const hist = firstLetterHistogram(['Mike', 'Mark', 'Matt', 'Zog', "'Aaron"]);
    expect(hist.get('m')).toEqual(['Mike', 'Mark', 'Matt']);
    expect(hist.get('z')).toEqual(['Zog']);
    expect(hist.get('a')).toEqual(["'Aaron"]); // leading punctuation stripped
  });
  it('skips letterless names', () => {
    const hist = firstLetterHistogram(['123', '', 'Bo']);
    expect([...hist.keys()]).toEqual(['b']);
  });
  it('buckets epithet names by their post-article letter, not the article', () => {
    // "THE CABARET SINGER" / "THE AUDIT-DRONES" must not both land under "t".
    const hist = firstLetterHistogram(['THE CABARET SINGER', 'THE AUDIT-DRONES', 'Mike']);
    expect([...hist.keys()].sort()).toEqual(['a', 'c', 'm']);
    expect(hist.has('t')).toBe(false);
  });
});

describe('findFirstLetterClusters', () => {
  it('flags a letter shared by enough of the cast', () => {
    const cast = ['Mike', 'Mark', 'Matt', 'Zog', 'Bree', 'Tom'];
    const clusters = findFirstLetterClusters(cast, { minCount: 3, maxRatio: 0.4 });
    expect(clusters).toHaveLength(1);
    expect(clusters[0].letter).toBe('m');
    expect(clusters[0].names).toEqual(['Mike', 'Mark', 'Matt']);
    expect(clusters[0].ratio).toBeCloseTo(0.5);
  });
  it('does not crowd an epithet cast under the article letter', () => {
    // A cast of "THE …" names must not register as "all start with T" — they are
    // bucketed by their real post-article first letter, which is spread out.
    const cast = [
      'THE CABARET SINGER', 'THE AUDIT-DRONES', 'THE CHILD',
      'THE READER', 'THE SMUGGLER', 'THE MINISTER',
    ];
    const clusters = findFirstLetterClusters(cast, { minCount: 3, maxRatio: 0.4 });
    expect(clusters.find((c) => c.letter === 't')).toBeUndefined();
  });

  it('does not flag a sparse first-letter share in a large cast (2 of 30)', () => {
    // 2 names start with M; the other 28 spread across 25 non-M letters (3 letters
    // doubled), so no letter is both shared by ≥3 names and ≥40% of the cast.
    const letters = 'abcdefghijklnopqrstuvwxyz'.split(''); // 25 letters, no 'm'
    const others = Array.from({ length: 28 }, (_, i) => `${letters[i % letters.length]}ame${i}`);
    const cast = ['Mike', 'Mark', ...others];
    expect(cast).toHaveLength(30);
    expect(findFirstLetterClusters(cast, { minCount: 3, maxRatio: 0.4 })).toEqual([]);
  });
  it('flags dense crowding (4 of 6) and sorts densest first', () => {
    const cast = ['Sam', 'Sid', 'Sue', 'Sky', 'Bree', 'Tom'];
    const clusters = findFirstLetterClusters(cast, { minCount: 3, maxRatio: 0.4 });
    expect(clusters[0].letter).toBe('s');
    expect(clusters[0].names).toHaveLength(4);
  });
  it('returns nothing for an empty cast', () => {
    expect(findFirstLetterClusters([])).toEqual([]);
  });
});
