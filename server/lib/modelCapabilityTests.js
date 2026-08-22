/**
 * Capability test catalog and scoring — pure.
 *
 * The Performance page answers "how FAST is this model here". This module backs
 * the other half: "can it actually DO the thing its badges claim". Each test is
 * bound to the capability badges the install catalog already shows
 * (`chat`/`code`/`reasoning`/`vision`/`tools`), so a test runs exactly where the
 * model made a claim worth checking.
 *
 * ## Two rules this file exists to hold
 *
 * 1. **An unclaimed capability is NOT a failure.** A model with no `vision`
 *    badge is `not-applicable` on the image test — never `failed`. That is what
 *    keeps the results matrix meaningful: a red cell always means "it said it
 *    could, and it could not".
 * 2. **Unknown is not empty.** A runtime that reports no capability list at all
 *    (a bare llama.cpp endpoint) yields `null`, which resolves to `unknown` —
 *    distinct from `[]`, which is a runtime that answered and named none. The
 *    UI offers an unknown-capability test rather than hiding or failing it.
 *
 * Scoring lives here rather than in the runner so every verdict is reproducible
 * from a stored transcript with no provider call — re-scoring an old run after
 * a keyword change costs nothing.
 */

import { escapeRegExp } from './textUtils.js';

/** Verdicts every scorer returns. `partial` is real evidence, not a soft fail. */
export const TEST_VERDICTS = Object.freeze(['passed', 'partial', 'failed']);

/**
 * The prompt each generative test sends, verbatim.
 *
 * Exported because the consent gate shows it before the first provider call —
 * a user agreeing to a run should be able to read what is about to be asked.
 * Fixed wording is also what makes two models' results comparable.
 */
export const CAPABILITY_TEST_PROMPTS = Object.freeze({
  'image-analysis': 'Describe everything you can see in this image, including colours, objects, and any text or numbers.',
  'story-outline': [
    'Premise: a tidal-marsh oyster farmer finds that the water killing her beds is coming from the sea wall she campaigned to build.',
    '',
    "Outline this as a hero's journey in twelve beats. Give each beat its standard name as a heading, followed by one short paragraph.",
  ].join('\n'),
});

/**
 * The task the sandbox agent is given. The sandbox already contains the broken
 * module, its test, and the data file the test reads — the model has to find
 * and read them, not be handed their contents.
 */
export const SANDBOX_TASK_PROMPT = [
  'This is a disposable PortOS capability check in the current directory.',
  'The test file cart-totals.test.mjs is failing.',
  'Read cart-totals.test.mjs, cart-totals.mjs and orders.json, then fix cart-totals.mjs on disk so the test passes.',
  'Run `node cart-totals.test.mjs` to check your work, and keep going until it exits 0.',
  'Do not edit cart-totals.test.mjs or orders.json, and do not create files outside this directory.',
].join(' ');

/**
 * One entry per test.
 *
 * `capabilities` is the badge set a model must ALREADY claim for the test to
 * apply — the gate, not a wish list. `prefers` is advisory only: it colours the
 * explanation ("a tool-caller without `code` usually narrates instead of
 * acting") and never decides applicability, because a model that clears the
 * gate deserves to be measured rather than pre-judged.
 */
export const CAPABILITY_TESTS = Object.freeze([
  Object.freeze({
    id: 'sandbox-repair',
    label: 'Sandbox repair',
    kind: 'agent',
    capabilities: Object.freeze(['tools']),
    prefers: Object.freeze(['code']),
    blurb: 'A broken module and its failing test are copied into a throwaway sandbox. The model must read the files, write a fix to disk, and make the test pass.',
    // Watching it work is the point of this one, so the runner drives a real
    // OpenCode TUI rather than an in-process tool loop.
    driver: 'tui',
  }),
  Object.freeze({
    id: 'image-analysis',
    label: 'Image analysis',
    kind: 'vision',
    capabilities: Object.freeze(['vision']),
    prefers: Object.freeze([]),
    blurb: 'A fixture image with known contents goes in; the description comes back. Scored on required and bonus keywords, so the check is deterministic.',
    driver: 'chat',
  }),
  Object.freeze({
    id: 'story-outline',
    label: 'Story outline',
    kind: 'text',
    capabilities: Object.freeze(['chat']),
    prefers: Object.freeze(['reasoning']),
    blurb: "Outline a hero's-journey story from one premise. Scored on how many of the twelve beats are present and in order.",
    driver: 'chat',
  }),
]);

export const CAPABILITY_TEST_IDS = Object.freeze(CAPABILITY_TESTS.map((t) => t.id));

export const getCapabilityTest = (id) => CAPABILITY_TESTS.find((t) => t.id === id) || null;

/**
 * Does this test apply to a model with these badges?
 *
 * @param {object} test one of CAPABILITY_TESTS
 * @param {string[]|null|undefined} capabilities `null`/`undefined` = the runtime
 *   reported none at all (unknown); `[]` = it answered and the model claims none.
 * @returns {{ state: 'applicable'|'not-applicable'|'unknown', missing: string[], reason: string|null }}
 */
export function applicabilityFor(test, capabilities) {
  if (!test) return { state: 'not-applicable', missing: [], reason: 'unknown test' };
  if (!Array.isArray(capabilities)) {
    return {
      state: 'unknown',
      missing: [],
      // Naming the runtime's silence rather than the model's: the model may well
      // be capable, and the UI offers the test anyway with this caveat attached.
      reason: 'this runtime reports no capability list, so the claim is unverified',
    };
  }
  const missing = test.capabilities.filter((c) => !capabilities.includes(c));
  if (missing.length) {
    return {
      state: 'not-applicable',
      missing,
      reason: `no ${missing.join(' or ')} badge`,
    };
  }
  return { state: 'applicable', missing: [], reason: null };
}

/** Every test with its applicability for one model. Order follows the catalog. */
export const applicableTests = (capabilities) =>
  CAPABILITY_TESTS.map((test) => ({ test, ...applicabilityFor(test, capabilities) }));

// ---- keyword scoring --------------------------------------------------------

/**
 * The vision fixture's known contents.
 *
 * REQUIRED are the four objects any usable vision model must name; the pass
 * turns on those alone. BONUS is detail work — two colours and a number painted
 * on a sign — which separates "captions the scene" from "reads the frame". A
 * model that gets every required term passes with bonus misses recorded, so the
 * score says what it was good at rather than collapsing to one number.
 */
export const VISION_FIXTURE_KEYWORDS = Object.freeze({
  required: Object.freeze([
    Object.freeze({ id: 'bicycle', label: 'Bicycle', any: Object.freeze(['bicycle', 'bike']) }),
    Object.freeze({ id: 'bench', label: 'Bench', any: Object.freeze(['bench']) }),
    Object.freeze({ id: 'lamp', label: 'Street lamp', any: Object.freeze(['lamp', 'lamppost', 'lamp post', 'streetlight', 'street light']) }),
    Object.freeze({ id: 'dog', label: 'Dog', any: Object.freeze(['dog', 'puppy']) }),
  ]),
  bonus: Object.freeze([
    Object.freeze({ id: 'red-bicycle', label: 'Bicycle is red', any: Object.freeze(['red', 'crimson', 'scarlet']) }),
    Object.freeze({ id: 'blue-bench', label: 'Bench is blue', any: Object.freeze(['blue']) }),
    Object.freeze({ id: 'sign-number', label: 'Reads the number 3 on the sign', any: Object.freeze(['3', 'three']) }),
  ]),
});

// A phrase is matched on word boundaries so "bike" does not fire on "bikeshed"
// and "3" does not fire inside "1024x3". Multi-word phrases tolerate any run of
// whitespace, because a wrapped transcript can break "lamp post" across lines.
const phrasePattern = (phrase) =>
  escapeRegExp(String(phrase).trim()).replace(/\\?\s+/g, '\\s+');

const keywordRegExp = (entry) =>
  new RegExp(`(?<![\\p{L}\\p{N}_])(?:${entry.any.map(phrasePattern).join('|')})(?![\\p{L}\\p{N}_])`, 'giu');

// "there is no dog" must not score as a dog. Only the few words immediately
// before the match are considered: a negation further back than that belongs to
// a different clause, and treating it as one here would start losing real hits.
const NEGATED_BEFORE = /\b(?:no|not|without|isn'?t|aren'?t|lacks?|lacking|missing|absent|cannot|can'?t)\b[^.;!?]{0,24}$/i;

const isNegated = (text, matchIndex) => NEGATED_BEFORE.test(text.slice(Math.max(0, matchIndex - 60), matchIndex));

/**
 * Is one keyword entry present in the text, ignoring negated mentions?
 * @returns {{ hit: boolean, matched: string|null }}
 */
export function findKeyword(text, entry) {
  const haystack = String(text || '');
  const re = keywordRegExp(entry);
  for (const match of haystack.matchAll(re)) {
    if (!isNegated(haystack, match.index)) return { hit: true, matched: match[0] };
  }
  return { hit: false, matched: null };
}

/**
 * Score a description against a required/bonus keyword spec.
 *
 * The pass turns on REQUIRED alone. Bonus terms are reported either way — they
 * are what makes two passing models distinguishable — but a bonus miss can
 * never fail a run, or "bonus" would just be a second required tier.
 */
export function scoreKeywords(text, spec = VISION_FIXTURE_KEYWORDS) {
  const score = (entries) => (entries || []).map((entry) => ({
    id: entry.id,
    label: entry.label,
    any: [...entry.any],
    ...findKeyword(text, entry),
  }));

  const required = score(spec.required);
  const bonus = score(spec.bonus);
  const requiredHit = required.filter((r) => r.hit).length;
  const bonusHit = bonus.filter((b) => b.hit).length;
  const verdict = requiredHit === required.length
    ? 'passed'
    : (requiredHit >= Math.ceil(required.length / 2) ? 'partial' : 'failed');

  return {
    verdict,
    required,
    bonus,
    requiredHit,
    requiredTotal: required.length,
    bonusHit,
    bonusTotal: bonus.length,
    summary: `${requiredHit} of ${required.length} required`
      + (bonus.length ? `, ${bonusHit} of ${bonus.length} bonus` : ''),
  };
}

// ---- story-beat scoring -----------------------------------------------------

/**
 * The twelve beats, with the wordings a model actually uses for each.
 *
 * Matching is on the beat NAME, not on the prose: the test asks for named
 * headings, so a missing heading is a missing beat rather than a scoring
 * failure. Alternates cover the common synonyms ("Call to adventure" /
 * "The call"), not every possible paraphrase — a model that renames the
 * structure has not produced the structure that was asked for.
 */
export const HEROS_JOURNEY_BEATS = Object.freeze([
  Object.freeze({ id: 'ordinary-world', label: 'Ordinary world', any: Object.freeze(['ordinary world', 'everyday world', 'status quo', 'the known world']) }),
  Object.freeze({ id: 'call-to-adventure', label: 'Call to adventure', any: Object.freeze(['call to adventure', 'the call', 'inciting incident']) }),
  Object.freeze({ id: 'refusal', label: 'Refusal of the call', any: Object.freeze(['refusal of the call', 'refusal', 'refuses the call']) }),
  Object.freeze({ id: 'mentor', label: 'Meeting the mentor', any: Object.freeze(['meeting the mentor', 'meeting with the mentor', 'the mentor', 'supernatural aid']) }),
  Object.freeze({ id: 'threshold', label: 'Crossing the threshold', any: Object.freeze(['crossing the threshold', 'crossing the first threshold', 'the threshold']) }),
  Object.freeze({ id: 'tests-allies', label: 'Tests, allies, enemies', any: Object.freeze(['tests, allies', 'tests allies', 'allies and enemies', 'the road of trials', 'trials']) }),
  Object.freeze({ id: 'approach', label: 'Approach to the inmost cave', any: Object.freeze(['approach to the inmost cave', 'inmost cave', 'innermost cave', 'the approach']) }),
  Object.freeze({ id: 'ordeal', label: 'The ordeal', any: Object.freeze(['the ordeal', 'ordeal', 'the central crisis']) }),
  Object.freeze({ id: 'reward', label: 'The reward', any: Object.freeze(['the reward', 'reward', 'seizing the sword']) }),
  Object.freeze({ id: 'road-back', label: 'The road back', any: Object.freeze(['the road back', 'road back', 'the return journey']) }),
  Object.freeze({ id: 'resurrection', label: 'Resurrection', any: Object.freeze(['resurrection', 'the final test', 'climax']) }),
  Object.freeze({ id: 'elixir', label: 'Return with the elixir', any: Object.freeze(['return with the elixir', 'the elixir', 'elixir', 'freedom to live']) }),
]);

/**
 * Score an outline for beat coverage and ordering.
 *
 * Coverage is structure, NOT quality — it can only say the model held a
 * twelve-part shape across a long generation. Whether the outline is any good is
 * a reading job, which is why the runner always keeps the full text.
 *
 * @returns {{verdict:string, beats:Array, found:number, total:number, inOrder:boolean, summary:string}}
 */
export function scoreStoryBeats(text, beats = HEROS_JOURNEY_BEATS) {
  const haystack = String(text || '');
  const scored = beats.map((beat) => {
    const re = keywordRegExp(beat);
    const match = re.exec(haystack);
    return {
      id: beat.id,
      label: beat.label,
      hit: Boolean(match),
      // Where the beat first appears, used for the ordering check. `null` for a
      // miss — never -1, which would sort ahead of every real position.
      at: match ? match.index : null,
    };
  });

  const hits = scored.filter((b) => b.hit);
  // Ordering is judged on the beats that ARE present: an outline missing beat 3
  // is not out of order, it is short one beat, and conflating the two would
  // punish the same gap twice.
  const inOrder = hits.every((beat, i) => i === 0 || beat.at > hits[i - 1].at);
  const found = hits.length;
  const verdict = found === beats.length && inOrder
    ? 'passed'
    : (found >= Math.ceil(beats.length * 0.66) ? 'partial' : 'failed');

  return {
    verdict,
    beats: scored,
    found,
    total: beats.length,
    inOrder,
    summary: `${found} of ${beats.length} beats${found > 1 && !inOrder ? ' — out of order' : ''}`,
  };
}

// ---- sandbox-repair scoring -------------------------------------------------

/**
 * Turn the observed facts of a sandbox run into a verdict.
 *
 * Every input is read from DISK after the agent stops — never from what the
 * agent said it did. A model that reports success without touching the file
 * scores nothing.
 *
 * @param {object} facts
 * @param {boolean} facts.moduleChanged the module under repair differs from the fixture
 * @param {boolean} facts.fixturesIntact the test and data files are byte-identical to the fixture
 * @param {boolean} facts.testsPass the sandbox test command exited 0
 * @param {number} facts.toolCalls tool calls observed in the agent stream
 */
export function scoreSandboxRepair({ moduleChanged, fixturesIntact, testsPass, toolCalls = 0 }) {
  const checks = [
    { id: 'module-written', label: 'Wrote a fix to the module on disk', ok: Boolean(moduleChanged) },
    { id: 'fixtures-intact', label: 'Left the test and data files untouched', ok: Boolean(fixturesIntact) },
    { id: 'tests-pass', label: 'The sandbox test command exits 0', ok: Boolean(testsPass) },
  ];
  // Editing the test into submission is the one way to "pass" without fixing
  // anything, so it fails outright rather than scoring partial — a partial there
  // would read as progress toward a solution it is moving away from.
  const verdict = !fixturesIntact
    ? 'failed'
    : (testsPass ? 'passed' : (moduleChanged ? 'partial' : 'failed'));
  const summary = verdict === 'passed'
    ? `fixed in ${toolCalls} tool call${toolCalls === 1 ? '' : 's'}`
    : (!fixturesIntact
      ? 'edited the test or data file instead of the module'
      : (moduleChanged ? 'wrote a fix, but the test still fails' : 'never wrote a fix'));

  return { verdict, checks, summary, toolCalls };
}

/** Roll several test verdicts into the one a model's row shows. */
export function rollUpVerdict(verdicts) {
  const list = (verdicts || []).filter((v) => TEST_VERDICTS.includes(v));
  if (!list.length) return null;
  if (list.includes('failed')) return 'failed';
  if (list.includes('partial')) return 'partial';
  return 'passed';
}

