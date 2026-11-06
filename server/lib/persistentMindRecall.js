import { STOP_WORDS } from './bm25.js';

export const PERSISTENT_MIND_RECALL_LIMITS = Object.freeze({
  maxRecords: 3,
  candidates: 20,
});

// Acknowledgements and recall phrasing ("what did we decide…") say nothing about
// which record is wanted; counting them would let "thanks, great" or "decide"
// alone satisfy the overlap gate. Compared before stemming.
const GENERIC_MESSAGE_TERMS = new Set([
  'about', 'agree', 'agreed', 'ago', 'ahead', 'again', 'am', 'appreciate', 'awesome', 'before',
  'chose', 'choice', 'choose', 'cool', 'decide', 'decided', 'decision', 'decisions', 'discuss',
  'discussed', 'done', 'earlier', 'fine', 'go', 'good', 'got', 'great', 'hello', 'here', 'hey',
  'hi', 'hmm', 'if', 'im', 'know', 'last', 'let', 'lets', 'lol', 'me', 'mention', 'mentioned',
  'mine', 'much', 'my', 'nice', 'nope', 'ok', 'okay', 'our', 'perfect', 'pick', 'picked', 'plan',
  'planned', 'please', 'previous', 'previously', 'really', 'recall', 'remember', 'right', 'said',
  'say', 'sound', 'sounds', 'sure', 'talk', 'talked', 'tell', 'thank', 'thanks', 'them', 'then',
  'there', 'these', 'think', 'those', 'thx', 'told', 'ty', 'us', 'we', 'yeah', 'yep', 'yes',
  'you', 'your', 'yours', 'yup',
]);

const words = (text) => (typeof text === 'string' ? text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [] : [])
  .filter((word) => word.length > 1 && !STOP_WORDS.has(word));

// Backends stem differently (Postgres english vs. exact BM25 tokens). A shared
// prefix keeps this gate at least as tolerant as ordinary inflection needs
// (migrate/migrations), without a dictionary.
const stem = (word) => word.replace(/s$/, '').slice(0, 6);

export function persistentMindRecallTerms(text) {
  return [...new Set(words(text).filter((word) => !GENERIC_MESSAGE_TERMS.has(word)).map(stem))];
}

/**
 * The gate above both ranked backends: their scores are not comparable, and a
 * ranked list always has a "best" row even when nothing is relevant. A record
 * must cover two message terms (the only term of a one-term message) and, for a
 * long message, about a third of them, so incidental overlap forces no context.
 */
export function selectPersistentMindRecall({ message, candidates = [], mindId, maxRecords = PERSISTENT_MIND_RECALL_LIMITS.maxRecords }) {
  const terms = persistentMindRecallTerms(message);
  if (terms.length === 0) return [];
  const required = Math.max(Math.min(2, terms.length), Math.ceil(terms.length * 0.3));
  return candidates
    .filter((memory) => memory?.status === 'active' && memory.sourceAgentId === mindId)
    .map((memory) => {
      const recordTerms = new Set(words(`${memory.content || ''} ${memory.summary || ''}`).map(stem));
      return { memory, matched: terms.filter((term) => recordTerms.has(term)).length };
    })
    .filter(({ matched }) => matched >= required)
    // Stable: equal coverage keeps the backend's relevance order.
    .sort((a, b) => b.matched - a.matched)
    .slice(0, maxRecords)
    .map(({ memory }) => memory);
}
