/**
 * Speech match — compare what a TTS line was SUPPOSED to say with what a
 * speech-to-text pass heard. Pure: normalizes case, punctuation and number
 * words, then scores word-level (character-level for CJK) edit distance.
 */

export const SPEECH_MATCH_THRESHOLD = 0.9;

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES = [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']];
const MAX_NUMBER = 999_999_999_999;

const CJK_RE = /[぀-ヿ㐀-䶿一-鿿가-힯]/u;

function below1000(n) {
  const words = [];
  if (n >= 100) {
    words.push(ONES[Math.floor(n / 100)], 'hundred');
    n %= 100;
  }
  if (n >= 20) {
    words.push(TENS[Math.floor(n / 10)]);
    n %= 10;
    if (n) words.push(ONES[n]);
  } else if (n > 0) {
    words.push(ONES[n]);
  }
  return words;
}

/** Spell a non-negative integer as English cardinal words ("12" -> "twelve"). */
function numberToWords(n) {
  if (!Number.isInteger(n) || n < 0 || n > MAX_NUMBER) return String(n);
  if (n === 0) return 'zero';
  const words = [];
  let rest = n;
  for (const [size, name] of SCALES) {
    if (rest >= size) {
      words.push(...below1000(Math.floor(rest / size)), name);
      rest %= size;
    }
  }
  words.push(...below1000(rest));
  return words.join(' ');
}

// "1999" is read "nineteen ninety nine" as often as "one thousand ...".
function yearWords(n) {
  if (n < 1100 || n > 2099 || n % 100 === 0) return null;
  const tail = n % 100;
  const head = below1000(Math.floor(n / 100)).join(' ');
  return tail < 10 ? `${head} oh ${ONES[tail]}` : `${head} ${below1000(tail).join(' ')}`;
}

function normalizeBase(text, numberReader) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/(\d+)\.(\d+)/g, (_m, a, b) => `${a} point ${[...b].join(' ')}`)
    .replace(/\d+/g, (m) => numberReader(m))
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .trim();
}

const cardinal = (m) => ` ${numberToWords(Number(m))} `;
const year = (m) => ` ${yearWords(Number(m)) ?? numberToWords(Number(m))} `;

function tokenize(normalized) {
  if (CJK_RE.test(normalized)) return [...normalized.replace(/\s+/g, '')];
  return normalized.split(/\s+/).filter(Boolean);
}

function editDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function similarityOf(expected, heard) {
  if (expected.length === 0 && heard.length === 0) return 1;
  return 1 - editDistance(expected, heard) / Math.max(expected.length, heard.length);
}

/**
 * Compare the script text with what was heard. A number may be read as a
 * cardinal or as a year, so the better of the two readings of each side wins.
 * @returns {{ status: 'matched'|'mismatch', similarity: number }}
 */
export function compareSpeech(expected, heard) {
  const readers = [cardinal, year];
  let best = 0;
  for (const ex of readers) {
    for (const he of readers) {
      const s = similarityOf(tokenize(normalizeBase(expected, ex)), tokenize(normalizeBase(heard, he)));
      if (s > best) best = s;
    }
  }
  const similarity = Math.round(best * 1000) / 1000;
  return { status: similarity >= SPEECH_MATCH_THRESHOLD ? 'matched' : 'mismatch', similarity };
}
