import { z } from 'zod';
import { EFFORT_LEVELS } from './providerModels.js';
import { extractJson } from './jsonExtract.js';

export const RHETORIC_MODE_IDS = Object.freeze([
  'meter',
  'diacope',
  'chiasmus',
  'progressia',
  'brainstorm',
]);

export const RHETORIC_DRILL_TYPES = Object.freeze(
  RHETORIC_MODE_IDS.map((mode) => `rhetoric-${mode}`),
);

export const RHETORIC_EVALUATOR_RUBRIC_VERSION = 'rhetoric-evaluator-v1';

export const RHETORIC_RUBRICS = Object.freeze({
  meter: Object.freeze([
    Object.freeze({ id: 'form', label: 'Meter and syllable control', instruction: 'Does the line make a credible attempt at ten syllables and a mostly rising da-DUM pulse?' }),
    Object.freeze({ id: 'image', label: 'Concrete image or thought', instruction: 'Does the line give the reader a specific image, turn, or thought rather than a generic statement?' }),
    Object.freeze({ id: 'sound', label: 'Line sound and finish', instruction: 'Does the line read naturally aloud and finish with a deliberate word or cadence?' }),
  ]),
  diacope: Object.freeze([
    Object.freeze({ id: 'pattern', label: 'Separated repetition', instruction: 'Is a word or phrase repeated with meaningful material between its appearances?' }),
    Object.freeze({ id: 'emphasis', label: 'Rhetorical force', instruction: 'Does the repetition add urgency, emphasis, or a changed implication?' }),
    Object.freeze({ id: 'voice', label: 'Natural voice', instruction: 'Does the sentence remain clear, intentional, and alive when read aloud?' }),
  ]),
  chiasmus: Object.freeze([
    Object.freeze({ id: 'reversal', label: 'Structural reversal', instruction: 'Are paired terms or structures presented again in reverse order?' }),
    Object.freeze({ id: 'meaning', label: 'Meaningful turn', instruction: 'Does the reversal sharpen, complicate, or transform the thought?' }),
    Object.freeze({ id: 'clarity', label: 'Clarity and balance', instruction: 'Can the sentence be understood without forcing the reader to decode the syntax?' }),
  ]),
  progressia: Object.freeze([
    Object.freeze({ id: 'steps', label: 'Discernible steps', instruction: 'Are there at least three identifiable stages, images, or movements?' }),
    Object.freeze({ id: 'escalation', label: 'Escalation or transformation', instruction: 'Does each stage intensify or transform what came before it?' }),
    Object.freeze({ id: 'landing', label: 'Earned landing', instruction: 'Does the final phrase feel like a satisfying consequence rather than an arbitrary largest word?' }),
  ]),
  brainstorm: Object.freeze([
    Object.freeze({ id: 'variety', label: 'Distinct angles', instruction: 'Are there at least three genuinely different approaches rather than one idea repeated?' }),
    Object.freeze({ id: 'specificity', label: 'Specific language', instruction: 'Do the attempts contain concrete, usable images or claims?' }),
    Object.freeze({ id: 'voltage', label: 'Unexpected turn', instruction: 'Does at least one version take a surprising, risky, or especially memorable angle?' }),
  ]),
});

const rhetoricDimensionSchema = z.object({
  id: z.string().trim().min(1).max(50),
  score: z.number().int().min(0).max(100),
  feedback: z.string().trim().min(1).max(1000),
}).strict();

const rhetoricEvaluationResponseSchema = z.object({
  overallScore: z.number().int().min(0).max(100),
  dimensions: z.array(rhetoricDimensionSchema).min(1).max(5),
  summary: z.string().trim().min(1).max(2000),
}).strict();

export const rhetoricEvaluationSchema = rhetoricEvaluationResponseSchema.extend({
  provenance: z.object({
    rubricVersion: z.string().trim().min(1).max(100),
    providerId: z.string().trim().min(1).max(300),
    model: z.string().trim().min(1).max(300),
    effort: z.enum(EFFORT_LEVELS).nullable(),
  }).strict(),
}).strict();

export function validateRhetoricEvaluationPayload(mode, value) {
  const parsed = rhetoricEvaluationResponseSchema.parse(value);
  const rubric = RHETORIC_RUBRICS[mode];
  if (!rubric) throw new Error(`Unknown rhetoric mode: ${mode}`);
  const expectedIds = rubric.map((criterion) => criterion.id);
  const actualIds = parsed.dimensions.map((dimension) => dimension.id);
  if (actualIds.length !== expectedIds.length || new Set(actualIds).size !== actualIds.length
    || expectedIds.some((id) => !actualIds.includes(id))) {
    throw new Error(`Rhetoric evaluator returned the wrong dimensions for ${mode}`);
  }
  return parsed;
}

export function buildRhetoricEvaluatorPrompt({ mode, prompt, response }) {
  const rubric = RHETORIC_RUBRICS[mode];
  if (!rubric) throw new Error(`Unknown rhetoric mode: ${mode}`);
  const rubricText = rubric.map((criterion) => `- ${criterion.id}: ${criterion.instruction}`).join('\n');
  const dimensionShape = JSON.stringify({
    overallScore: 0,
    dimensions: rubric.map((criterion) => ({ id: criterion.id, score: 0, feedback: 'brief evidence' })),
    summary: 'one concise paragraph',
  });
  return [
    'Evaluate one POST rhetoric-practice attempt as a careful writing coach.',
    'Use only the supplied prompt, attempt, and rubric. Do not reward length, confidence, or agreement with the evaluator.',
    'Score each dimension from 0 to 100, then give an overall score from 0 to 100. Be specific but concise.',
    'Return ONLY valid JSON. Do not use markdown or add keys outside this shape:',
    dimensionShape,
    `Mode: ${mode}`,
    'Rubric:',
    rubricText,
    `Practice prompt: ${prompt}`,
    `Practice attempt: ${response}`,
  ].join('\n\n');
}

// This is deliberately committed, fictional reference material rather than a
// user's POST history. It is a small expert-labelled corpus: enough varied
// examples to expose evaluator calibration, while still fitting in one bounded
// local-model request. The reference responses are the material under test; the
// expected scores are the gold labels, not part of the model prompt.
export const RHETORIC_REFERENCE_SET = Object.freeze([
  { id: 'meter-01', mode: 'meter', prompt: 'Write a line about an empty train station.', response: 'The last train sighs softly through the rain.', expectedScore: 86 },
  { id: 'meter-02', mode: 'meter', prompt: 'Write a line that turns from doubt to hope.', response: 'I fear the dark, yet dawn is on its way.', expectedScore: 87 },
  { id: 'meter-03', mode: 'meter', prompt: 'Write a line containing the word “winter”.', response: 'Winter lays its silver hand across the town.', expectedScore: 84 },
  { id: 'meter-04', mode: 'meter', prompt: 'Write a line spoken by someone keeping a secret.', response: 'I keep the key where no one hears it turn.', expectedScore: 81 },
  { id: 'meter-05', mode: 'meter', prompt: 'Write a line that ends on a strong one-syllable noun.', response: 'The empty platform waits beneath the moon.', expectedScore: 83 },
  { id: 'meter-06', mode: 'meter', prompt: 'Write a line about a lighthouse.', response: 'The lighthouse blinks, then swallows up the dark.', expectedScore: 78 },
  { id: 'meter-07', mode: 'meter', prompt: 'Write a line about an empty train station.', response: 'Train station empty I am sad today.', expectedScore: 28 },
  { id: 'meter-08', mode: 'meter', prompt: 'Write a line containing the word “winter”.', response: 'Winter is cold and the station has a train.', expectedScore: 35 },

  { id: 'diacope-01', mode: 'diacope', prompt: 'Write a warning using “stay”.', response: 'Stay, until the sirens learn our names. Stay.', expectedScore: 90 },
  { id: 'diacope-02', mode: 'diacope', prompt: 'Write a plea using “listen”.', response: 'Listen, the room is listening back. Listen.', expectedScore: 87 },
  { id: 'diacope-03', mode: 'diacope', prompt: 'Write a defiant line using “no”.', response: 'No, I will not bow to borrowed thunder. No.', expectedScore: 91 },
  { id: 'diacope-04', mode: 'diacope', prompt: 'Write a comic line using “again”.', response: 'Again, the joke wore shoes and left the room. Again.', expectedScore: 79 },
  { id: 'diacope-05', mode: 'diacope', prompt: 'Write a line about trust.', response: 'The key is trust, and trust is the key.', expectedScore: 31 },
  { id: 'diacope-06', mode: 'diacope', prompt: 'Write a line using “run”.', response: 'Run run run.', expectedScore: 20 },
  { id: 'diacope-07', mode: 'diacope', prompt: 'Write a plea using “listen”.', response: 'Please listen to my listen.', expectedScore: 30 },
  { id: 'diacope-08', mode: 'diacope', prompt: 'Write a line about returning home.', response: 'Home, after all the roads, home.', expectedScore: 85 },

  { id: 'chiasmus-01', mode: 'chiasmus', prompt: 'Write a line about learning that reverses its key terms.', response: 'We teach our questions, and our questions teach us.', expectedScore: 90 },
  { id: 'chiasmus-02', mode: 'chiasmus', prompt: 'Turn a choice between freedom and safety into a crossed sentence.', response: 'Freedom needs safety, but safety needs freedom.', expectedScore: 83 },
  { id: 'chiasmus-03', mode: 'chiasmus', prompt: 'Write a compact chiasmus about listening and speaking.', response: 'We speak to be heard, and listen to be understood.', expectedScore: 63 },
  { id: 'chiasmus-04', mode: 'chiasmus', prompt: 'Use a reversal to show a friendship changing over time.', response: 'She changed the plan, and the plan changed her.', expectedScore: 88 },
  { id: 'chiasmus-05', mode: 'chiasmus', prompt: 'Write a comic chiasmus about making plans and plans making trouble.', response: 'I make my schedule, then my schedule makes me.', expectedScore: 85 },
  { id: 'chiasmus-06', mode: 'chiasmus', prompt: 'Write a line about plans and trouble.', response: 'Plans made trouble, and trouble made plans.', expectedScore: 66 },
  { id: 'chiasmus-07', mode: 'chiasmus', prompt: 'Write a line about practice.', response: 'Learning is the point of practice, and practice is learning.', expectedScore: 70 },
  { id: 'chiasmus-08', mode: 'chiasmus', prompt: 'Write a line about a cat and a mouse.', response: 'The cat chased the mouse and the mouse chased the cat.', expectedScore: 55 },

  { id: 'progressia-01', mode: 'progressia', prompt: 'Escalate a whisper into a public alarm.', response: 'A whisper became a rumor, a rumor became a warning, a warning became a bell.', expectedScore: 92 },
  { id: 'progressia-02', mode: 'progressia', prompt: 'Build a three-step progression from want to need to obsession.', response: 'I wanted a cup, then a pot, then the whole river.', expectedScore: 81 },
  { id: 'progressia-03', mode: 'progressia', prompt: 'Turn a small kindness into a changed life.', response: 'Kindness warmed a hand, a home, a street.', expectedScore: 78 },
  { id: 'progressia-04', mode: 'progressia', prompt: 'Escalate a disagreement without using the word “anger”.', response: 'The quarrel sharpened to a shout, a shove, a slammed door.', expectedScore: 82 },
  { id: 'progressia-05', mode: 'progressia', prompt: 'Build from a single drop of water to a flood.', response: 'A drop became a stream, a stream became a river, a river took the road.', expectedScore: 90 },
  { id: 'progressia-06', mode: 'progressia', prompt: 'Build a progression from noticing to action.', response: 'First I noticed it, then I thought about it.', expectedScore: 35 },
  { id: 'progressia-07', mode: 'progressia', prompt: 'Escalate a simple idea.', response: 'Big, bigger, biggest.', expectedScore: 45 },
  { id: 'progressia-08', mode: 'progressia', prompt: 'Build from wanting something to obsession.', response: 'He wanted things and got more things.', expectedScore: 22 },

  { id: 'brainstorm-01', mode: 'brainstorm', prompt: 'Brainstorm three openings for a story about a locked room.', response: 'Locked room: a witness, a coffin, a seed vault.', expectedScore: 88 },
  { id: 'brainstorm-02', mode: 'brainstorm', prompt: 'Argue for, against, and sideways about convenience.', response: 'Convenience is a gift, a trap, and a habit wearing a smile.', expectedScore: 86 },
  { id: 'brainstorm-03', mode: 'brainstorm', prompt: 'Find three metaphors for a difficult conversation.', response: 'A bridge under repair, a knot, a weather report.', expectedScore: 84 },
  { id: 'brainstorm-04', mode: 'brainstorm', prompt: 'Write three headlines for the same surprising event.', response: 'Local Door Refuses to Open; Room Wins Standoff; Key Takes the Day Off.', expectedScore: 91 },
  { id: 'brainstorm-05', mode: 'brainstorm', prompt: 'Describe one ordinary object as sacred, dangerous, and ridiculous.', response: 'A spoon: a chalice, a weapon, a tiny mirror.', expectedScore: 89 },
  { id: 'brainstorm-06', mode: 'brainstorm', prompt: 'Brainstorm three openings for a story about a locked room.', response: 'Locked room. Another locked room. A room is locked.', expectedScore: 25 },
  { id: 'brainstorm-07', mode: 'brainstorm', prompt: 'Argue for and against convenience.', response: 'Convenience is good and bad.', expectedScore: 30 },
  { id: 'brainstorm-08', mode: 'brainstorm', prompt: 'Describe one ordinary object in three surprising ways.', response: 'Sacred, dangerous, ridiculous: a mug, a mug, a mug.', expectedScore: 38 },
]);

const rhetoricReferenceResponseSchema = z.object({
  evaluations: z.array(z.object({
    id: z.string().trim().min(1).max(100),
    score: z.number().min(0).max(100),
  }).strict()).min(1).max(RHETORIC_REFERENCE_SET.length),
}).strict();

export function buildRhetoricReferencePrompt(referenceSet = RHETORIC_REFERENCE_SET) {
  const examples = referenceSet.map(({ id, mode, prompt, response }) => ({ id, mode, prompt, response }));
  return [
    'You are being benchmarked as a rhetoric-practice evaluator.',
    'Score every reference attempt from 0 to 100 using the mode-specific criteria below.',
    'Judge the attempt against its prompt. Do not infer hidden intent, and do not omit any item.',
    'Return ONLY valid JSON with exactly one evaluation for every id:',
    '{"evaluations":[{"id":"meter-01","score":0}]}',
    'Criteria:',
    Object.entries(RHETORIC_RUBRICS).map(([mode, rubric]) => `${mode}: ${rubric.map((criterion) => criterion.instruction).join(' ')}`).join('\n'),
    'Reference attempts:',
    JSON.stringify(examples),
  ].join('\n\n');
}

export function parseRhetoricJson(content, shapePredicate) {
  if (!content || typeof content !== 'string') throw new Error('Empty rhetoric evaluator response');
  const { value, lastError } = extractJson(content, {
    // The evaluator prompt itself contains a fenced shape example. Walk all
    // balanced candidates so a CLI prompt echo cannot become the score.
    skipInnerFence: true,
    shapePredicate,
  });
  if (value === undefined) {
    throw new Error(`Failed to parse rhetoric evaluator response: ${lastError?.message || 'No JSON found'}`);
  }
  return value;
}

export function scoreRhetoricReference(value, referenceSet = RHETORIC_REFERENCE_SET) {
  const parsed = rhetoricReferenceResponseSchema.parse(value);
  const expectedIds = referenceSet.map((item) => item.id);
  const predictions = new Map(parsed.evaluations.map((item) => [item.id, item.score]));
  if (predictions.size !== parsed.evaluations.length || predictions.size !== expectedIds.length
    || expectedIds.some((id) => !predictions.has(id))) {
    throw new Error(`Rhetoric reference evaluator returned ${predictions.size} of ${expectedIds.length} unique ids`);
  }
  const items = referenceSet.map((item) => ({
    id: item.id,
    expected: item.expectedScore,
    predicted: Math.round(predictions.get(item.id)),
    absoluteError: Math.abs(Math.round(predictions.get(item.id)) - item.expectedScore),
  }));
  const meanAbsoluteError = Math.round(items.reduce((sum, item) => sum + item.absoluteError, 0) / items.length * 10) / 10;
  const within10Count = items.filter((item) => item.absoluteError <= 10).length;
  const within20Count = items.filter((item) => item.absoluteError <= 20).length;
  const within20Rate = within20Count / items.length;
  const verdict = meanAbsoluteError <= 12 && within20Rate >= 0.8
    ? 'passed'
    : (meanAbsoluteError <= 25 && within20Rate >= 0.6 ? 'partial' : 'failed');
  return {
    verdict,
    summary: `${items.length} reference attempts; mean absolute error ${meanAbsoluteError} points; ${within20Count}/${items.length} within 20 points`,
    referenceCount: referenceSet.length,
    evaluatedCount: items.length,
    meanAbsoluteError,
    within10Count,
    within20Count,
    within10Rate: Math.round(within10Count / items.length * 1000) / 1000,
    within20Rate: Math.round(within20Rate * 1000) / 1000,
    items,
  };
}
