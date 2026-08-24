/**
 * MeatSpace POST - LLM-Powered Drills
 *
 * Generates and scores cognitive drills that use an AI provider:
 * - word-association: lateral thinking via word associations
 * - story-recall: working memory via paragraph recall
 * - verbal-fluency: category fluency (name items in a category)
 * - wit-comeback: verbal agility via witty responses
 * - pun-wordplay: creative wordplay and pun generation
 */

import { getActiveProvider, getProviderById } from './providers.js';
import { runPromptThroughProvider } from './promptRunner.js';
import {
  LEGACY_POST_LLM_PROVENANCE,
  POST_LLM_MAX_SEMANTIC_CANDIDATES,
  buildPostLlmGeneratorProvenance,
  buildPostLlmScorerProvenance,
  postLlmEvaluationSchema,
  validatePostLlmGenerationPayload,
  validatePostLlmScorePayload,
  validatePostLlmSemanticVerdicts,
} from '../lib/postLlmContracts.js';

export const LLM_DRILL_TYPES = [
  'word-association',
  'story-recall',
  'verbal-fluency',
  'wit-comeback',
  'pun-wordplay',
  'compound-chain',
  'bridge-word',
  'double-meaning',
  'idiom-twist',
  'what-if',
  'alternative-uses',
  'story-prompt',
  'invention-pitch',
  'reframe',
];

// ─────────────────────────────────────────────────────────────────────────────
// AI CALLER (mirrors brain.js pattern)
// ─────────────────────────────────────────────────────────────────────────────

export async function callAI(prompt, providerId, model, effort = null, source = 'meatspace-post-llm') {
  const provider = providerId
    ? await getProviderById(providerId)
    : await getActiveProvider();

  if (!provider?.enabled) {
    throw new Error('No AI provider available for POST drills');
  }

  const selectedModel = model || provider.defaultModel;
  console.log(`🧪 POST LLM: ${provider.id} / ${selectedModel}`);

  // Append headlessArgs so claude-code's POST drills don't pollute the
  // user's session list. The clone leaves the saved provider config
  // untouched. Default timeout for POST drills is shorter than the
  // central handler's default (2 min vs 5) since drills should be snappy.
  const providerForCall = provider.headlessArgs?.length
    ? { ...provider, args: [...(provider.args || []), ...provider.headlessArgs] }
    : provider;

  const result = await runPromptThroughProvider({
    provider: providerForCall, prompt, source, model: selectedModel, effort,
    timeout: provider.timeout || 120000,
  });
  return {
    text: result.text,
    providerId: provider.id || 'unknown',
    model: result.model || selectedModel || 'unknown',
  };
}

export function parseJsonFromAI(content) {
  if (!content || typeof content !== 'string') throw new Error('Empty AI response');
  let jsonStr = content.trim();
  // Strip fenced code blocks
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) jsonStr = jsonMatch[1].trim();
  // Extract first JSON object/array from surrounding text
  const objectMatch = jsonStr.match(/(\{[\s\S]*\})/);
  if (objectMatch) jsonStr = objectMatch[1];
  else {
    const arrayMatch = jsonStr.match(/(\[[\s\S]*\])/);
    if (arrayMatch) jsonStr = arrayMatch[1];
  }
  return JSON.parse(jsonStr);
}

async function generateValidatedPayload(type, count, prompt, providerId, model) {
  const response = await callAI(prompt, providerId, model);
  return {
    data: validatePostLlmGenerationPayload(type, parseJsonFromAI(response.text), count),
    generation: buildPostLlmGeneratorProvenance(type, response.providerId, response.model),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DRILL GENERATORS
// ─────────────────────────────────────────────────────────────────────────────

export async function generateWordAssociation(config, providerId, model) {
  const count = config.count || 5;
  const prompt = `Generate ${count} word association prompts for a cognitive training exercise.
For each prompt, provide a single word or short concept that the user will free-associate with.
Choose diverse, interesting words that encourage creative lateral thinking.
Mix concrete nouns, abstract concepts, and evocative words.

Return ONLY valid JSON (no markdown, no explanation):
{"questions":[{"prompt":"the word","hints":"optional category hint"}]}

Example: {"questions":[{"prompt":"cathedral","hints":"architecture/spirituality"}]}`;

  const { data, generation } = await generateValidatedPayload('word-association', count, prompt, providerId, model);
  return {
    type: 'word-association',
    config: { count },
    generation,
    questions: data.questions.map(q => ({
      prompt: q.prompt,
      hints: q.hints,
    }))
  };
}

export async function generateStoryRecall(config, providerId, model) {
  const count = config.count || 3;
  const prompt = `Generate ${count} short story recall exercises for cognitive training.
Each exercise has a short paragraph (2-4 sentences) containing specific details: names, numbers, places, colors, dates.
Then provide 3-4 recall questions about those details, each with a correct answer.

Return ONLY valid JSON:
{"exercises":[{"paragraph":"The story text...","questions":[{"question":"Who visited?","answer":"Jane","aliases":[]},{"question":"Where did she go?","answer":"New York City","aliases":["NYC"]},{"question":"When did she go?","answer":"Monday","aliases":[]}]}]}

Make paragraphs vivid and varied. Include specific numbers, proper nouns, and concrete details.
Only declare aliases that are complete interchangeable answers (for example "NYC" for "New York City"); do not list fragments or substrings.`;

  const { data, generation } = await generateValidatedPayload('story-recall', count, prompt, providerId, model);
  return {
    type: 'story-recall',
    config: { count },
    generation,
    exercises: data.exercises,
  };
}

export async function generateVerbalFluency(config, providerId, model) {
  const count = config.count || 3;
  const prompt = `Generate ${count} verbal fluency category prompts for cognitive training.
Each prompt is a category where the user must name as many items as possible within a time limit.
Choose categories with many valid answers (at least 20+).
Mix common categories with more creative/specific ones.

Return ONLY valid JSON:
{"categories":[{"category":"Animals","minExpected":15,"examples":["dog","cat","elephant"]}]}

The examples field should contain 3-5 sample answers for validation reference.
minExpected is the minimum number a healthy adult should name in 60 seconds.`;

  const { data, generation } = await generateValidatedPayload('verbal-fluency', count, prompt, providerId, model);
  return {
    type: 'verbal-fluency',
    config: { count },
    generation,
    categories: data.categories,
  };
}

export async function generateWitComeback(config, providerId, model) {
  const count = config.count || 5;
  const prompt = `Generate ${count} witty comeback/response scenarios for verbal agility training.
Each scenario presents a situation, statement, or setup that the user must respond to with wit and humor.
Mix scenarios: awkward social situations, playful roasts, clever observations, absurd hypotheticals.

Return ONLY valid JSON:
{"scenarios":[{"setup":"The scenario or statement","context":"brief context about the situation","difficulty":"easy|medium|hard"}]}

Make setups varied and fun. Range from easy (obvious joke setup) to hard (requires clever lateral thinking).`;

  const { data, generation } = await generateValidatedPayload('wit-comeback', count, prompt, providerId, model);
  return {
    type: 'wit-comeback',
    config: { count },
    generation,
    scenarios: data.scenarios,
  };
}

export async function generatePunWordplay(config, providerId, model) {
  const count = config.count || 5;
  const prompt = `Generate ${count} pun and wordplay challenges for creative language training.
Each challenge gives the user a topic, theme, or constraint and asks them to create a pun, wordplay, or clever phrase.
Mix challenge types: create a pun about a topic, complete a punny sentence, name a punny business, write a wordplay headline.

Return ONLY valid JSON:
{"challenges":[{"type":"pun-topic|complete-sentence|punny-name|wordplay-headline","prompt":"The challenge description","topic":"the subject area","example":"an example of a good answer"}]}

Make challenges diverse and fun. The example should be witty but not the only valid answer.`;

  const { data, generation } = await generateValidatedPayload('pun-wordplay', count, prompt, providerId, model);
  return {
    type: 'pun-wordplay',
    config: { count },
    generation,
    challenges: data.challenges,
  };
}

export async function generateWhatIf(config, providerId, model) {
  const count = config.count || 3;
  const prompt = `Generate ${count} creative "What If" hypothetical scenarios for imagination training.
Each scenario should be absurd, thought-provoking, and fun to reason about.
Mix science, society, nature, and everyday life. Be creative and specific.

Return ONLY valid JSON:
{"scenarios":[{"prompt":"What if gravity reversed for 10 minutes every Tuesday?","category":"physics"}]}`;

  const { data, generation } = await generateValidatedPayload('what-if', count, prompt, providerId, model);
  return {
    type: 'what-if',
    config: { count },
    generation,
    scenarios: data.scenarios,
  };
}

export async function generateAlternativeUses(config, providerId, model) {
  const count = config.count || 3;
  const prompt = `Generate ${count} "Alternative Uses" challenges for divergent thinking training.
Each challenge names a common everyday object. The user must list creative, unusual uses for it.
Pick objects that have many possible creative uses.

Return ONLY valid JSON:
{"objects":[{"object":"brick","commonUse":"building material","minExpected":8}]}`;

  const { data, generation } = await generateValidatedPayload('alternative-uses', count, prompt, providerId, model);
  return {
    type: 'alternative-uses',
    config: { count },
    generation,
    objects: data.objects,
  };
}

export async function generateStoryPrompt(config, providerId, model) {
  const count = config.count || 3;
  const prompt = `Generate ${count} "Story Prompt" challenges for creative writing training.
Each challenge gives exactly 3 random, unrelated words. The user must write a micro-story (2-4 sentences) connecting all three words.
Choose words that are surprising when combined.

Return ONLY valid JSON:
{"prompts":[{"words":["lighthouse","saxophone","marmalade"]}]}`;

  const { data, generation } = await generateValidatedPayload('story-prompt', count, prompt, providerId, model);
  return {
    type: 'story-prompt',
    config: { count },
    generation,
    prompts: data.prompts,
  };
}

export async function generateInventionPitch(config, providerId, model) {
  const count = config.count || 3;
  const prompt = `Generate ${count} "Invention Pitch" challenges for creative problem-solving training.
Each challenge describes a specific, relatable problem. The user must pitch an inventive solution in 2-3 sentences.
Mix everyday annoyances, workplace challenges, and social problems.

Return ONLY valid JSON:
{"problems":[{"problem":"You always forget where you put your keys","category":"everyday","difficulty":"easy"}]}`;

  const { data, generation } = await generateValidatedPayload('invention-pitch', count, prompt, providerId, model);
  return {
    type: 'invention-pitch',
    config: { count },
    generation,
    problems: data.problems,
  };
}

export async function generateReframe(config, providerId, model) {
  const count = config.count || 3;
  const prompt = `Generate ${count} "Reframe" challenges for positive thinking and humor training.
Each challenge describes a frustrating or negative situation. The user must reframe it positively, humorously, or find a silver lining.
Mix minor annoyances with bigger setbacks. Keep them relatable.

Return ONLY valid JSON:
{"situations":[{"situation":"Your flight was delayed by 4 hours","severity":"medium"}]}`;

  const { data, generation } = await generateValidatedPayload('reframe', count, prompt, providerId, model);
  return {
    type: 'reframe',
    config: { count },
    generation,
    situations: data.situations,
  };
}

export async function generateCompoundChain(config, providerId, model) {
  const count = config.count || 5;
  const prompt = `Generate ${count} compound word/phrase association challenges for verbal training.
For each challenge, provide a root word that appears in many compound words or common phrases.
Choose words with at least 10+ valid compound combinations (as prefix or suffix).
Mix common roots (fire, back, hand) with less obvious ones (cross, break, light).

Return ONLY valid JSON (no markdown, no explanation):
{"challenges":[{"rootWord":"paper","position":"prefix","examples":["paperback","paper trail","paperweight","paper clip","paper thin","paper plane","paper cut","paper mill","paper bag","paper tiger"],"minExpected":8}]}

position is "prefix" if the root starts the compound (firehouse), "suffix" if it ends it (campfire), or "both" if common either way (light→lighthouse, flashlight).
The examples field should contain 10-15 sample answers for reference. minExpected is the target count.`;

  const { data, generation } = await generateValidatedPayload('compound-chain', count, prompt, providerId, model);
  return {
    type: 'compound-chain',
    config: { count },
    generation,
    challenges: data.challenges.map(c => ({
      rootWord: c.rootWord,
      position: c.position,
      examples: c.examples,
      minExpected: c.minExpected,
    }))
  };
}

export async function generateBridgeWord(config, providerId, model) {
  const count = config.count || 5;
  const prompt = `Generate ${count} "bridge word" puzzles for verbal association training.
In each puzzle, a single hidden word connects multiple given phrases or compound words.
For example: "news___", "___back", "___weight" → answer is "paper" (newspaper, paperback, paperweight).

Each puzzle should have 3-4 clue phrases with blanks where the bridge word goes.
Choose bridge words that have many natural compound forms. Vary difficulty.

Return ONLY valid JSON (no markdown, no explanation):
{"puzzles":[{"clues":["news___","___back","___weight","___clip"],"answer":"paper","difficulty":"easy","hint":"Something you write on"}]}`;

  const { data, generation } = await generateValidatedPayload('bridge-word', count, prompt, providerId, model);
  return {
    type: 'bridge-word',
    config: { count },
    generation,
    puzzles: data.puzzles.map(p => ({
      clues: p.clues,
      answer: p.answer,
      difficulty: p.difficulty,
      hint: p.hint,
    }))
  };
}

export async function generateDoubleMeaning(config, providerId, model) {
  const count = config.count || 5;
  const prompt = `Generate ${count} "double meaning" wordplay challenges for verbal association training.
Each challenge presents a word that has multiple unrelated meanings (homonyms/polysemy).
The user must write a single sentence or short phrase that cleverly uses BOTH meanings at once.

For example: "bark" (tree bark + dog bark) → "The dog's bark was louder than the oak's bark."
"scale" (weight scale + fish scale + musical scale) → multiple meanings to play with.

Choose words with clearly distinct meanings that are fun to combine.

Return ONLY valid JSON (no markdown, no explanation):
{"challenges":[{"word":"bark","meanings":["outer covering of a tree","sound a dog makes"],"example":"The dog's bark echoed off the bark of the old oak.","difficulty":"easy"}]}`;

  const { data, generation } = await generateValidatedPayload('double-meaning', count, prompt, providerId, model);
  return {
    type: 'double-meaning',
    config: { count },
    generation,
    challenges: data.challenges.map(c => ({
      word: c.word,
      meanings: c.meanings,
      example: c.example,
      difficulty: c.difficulty,
    }))
  };
}

export async function generateIdiomTwist(config, providerId, model) {
  const count = config.count || 5;
  const prompt = `Generate ${count} "idiom twist" challenges for creative wordplay training.
Each challenge presents a well-known idiom/phrase AND a new domain/context.
The user must adapt the idiom to the new domain using wordplay, puns, or clever substitution.

For example:
- Idiom: "Don't put all your eggs in one basket" + Domain: "Programming"
  → "Don't put all your bugs in one branch"
- Idiom: "The early bird catches the worm" + Domain: "Stock market"
  → "The early trader catches the dip"

Choose well-known idioms and fun, diverse domains. Mix easy and hard combinations.

Return ONLY valid JSON (no markdown, no explanation):
{"challenges":[{"idiom":"Don't put all your eggs in one basket","domain":"programming","example":"Don't push all your commits to one branch","difficulty":"easy"}]}`;

  const { data, generation } = await generateValidatedPayload('idiom-twist', count, prompt, providerId, model);
  return {
    type: 'idiom-twist',
    config: { count },
    generation,
    challenges: data.challenges.map(c => ({
      idiom: c.idiom,
      domain: c.domain,
      example: c.example,
      difficulty: c.difficulty,
    }))
  };
}

export async function generateLlmDrill(type, config = {}, providerId, model) {
  switch (type) {
    case 'word-association':
      return generateWordAssociation(config, providerId, model);
    case 'story-recall':
      return generateStoryRecall(config, providerId, model);
    case 'verbal-fluency':
      return generateVerbalFluency(config, providerId, model);
    case 'wit-comeback':
      return generateWitComeback(config, providerId, model);
    case 'pun-wordplay':
      return generatePunWordplay(config, providerId, model);
    case 'compound-chain':
      return generateCompoundChain(config, providerId, model);
    case 'bridge-word':
      return generateBridgeWord(config, providerId, model);
    case 'double-meaning':
      return generateDoubleMeaning(config, providerId, model);
    case 'idiom-twist':
      return generateIdiomTwist(config, providerId, model);
    case 'what-if':
      return generateWhatIf(config, providerId, model);
    case 'alternative-uses':
      return generateAlternativeUses(config, providerId, model);
    case 'story-prompt':
      return generateStoryPrompt(config, providerId, model);
    case 'invention-pitch':
      return generateInventionPitch(config, providerId, model);
    case 'reframe':
      return generateReframe(config, providerId, model);
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM SCORING
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// SCORING HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function averageScore(scores) {
  return scores.length > 0
    ? Math.round(scores.reduce((s, x) => s + x.score, 0) / scores.length)
    : 0;
}

function buildScoringResult(evaluation, userResponses, speedBonus) {
  const qualityScore = evaluation.overallScore;
  const finalScore = Math.min(100, Math.max(0, Math.round(qualityScore * 0.8 + speedBonus * 0.2 * 100)));
  return {
    score: finalScore,
    evaluation,
    questions: userResponses.map((r, i) => ({
      ...r,
      llmScore: evaluation.scores[i].score,
      llmFeedback: evaluation.scores[i].feedback,
    }))
  };
}

function normalizeAnswer(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeCompound(value) {
  return normalizeAnswer(value).replace(/\s/g, '');
}

function evaluationWithProvenance(type, drillData, evaluation, kind, providerId = 'local', model = 'local') {
  return postLlmEvaluationSchema.parse({
    ...evaluation,
    provenance: {
      generator: drillData?.generation || LEGACY_POST_LLM_PROVENANCE.generator,
      scorer: buildPostLlmScorerProvenance(type, kind, providerId, model),
    },
  });
}

async function semanticVerdicts(candidates, prompt, providerId, model, label) {
  if (candidates.length === 0) return { verdicts: new Map(), providerId: 'local', model: 'local' };
  if (candidates.length > POST_LLM_MAX_SEMANTIC_CANDIDATES) {
    throw new Error(`Cannot score ${candidates.length} open-ended items in one bounded batch (max ${POST_LLM_MAX_SEMANTIC_CANDIDATES})`);
  }
  const response = await callAI(prompt, providerId, model);
  const parsed = validatePostLlmSemanticVerdicts(parseJsonFromAI(response.text), candidates, label);
  return {
    verdicts: new Map(parsed.verdicts.map((verdict) => [`${verdict.responseIndex}:${verdict.itemIndex}`, verdict.valid])),
    providerId: response.providerId,
    model: response.model,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LOCAL (INSTANT) SCORING — no LLM call needed
// ─────────────────────────────────────────────────────────────────────────────

function scoreLocalBridgeWord(drillData, userResponses) {
  const scores = userResponses.map((r, i) => {
    const puzzle = drillData.puzzles?.[r.questionIndex ?? i];
    if (!puzzle?.answer) throw new Error(`Cannot score bridge-word response ${i}: missing answer key`);
    const userAnswer = normalizeAnswer(r.response);
    const correct = normalizeAnswer(puzzle.answer);
    const isCorrect = userAnswer === correct;
    return {
      score: isCorrect ? 100 : 0,
      feedback: isCorrect ? 'Correct!' : `The answer was "${puzzle.answer}"`,
    };
  });
  const overallScore = averageScore(scores);
  return { overallScore, scores, summary: `${scores.filter(s => s.score === 100).length} of ${scores.length} correct` };
}

function matchedCompoundExample(challenge, item) {
  const root = normalizeCompound(challenge.rootWord);
  const normalized = normalizeCompound(item);
  return (challenge.examples || []).find((example) => {
    const full = normalizeCompound(example);
    if (normalized === full) return true;
    if ((challenge.position === 'prefix' || challenge.position === 'both') && full.startsWith(root)) {
      if (normalized === full.slice(root.length)) return true;
    }
    if ((challenge.position === 'suffix' || challenge.position === 'both') && full.endsWith(root)) {
      if (normalized === full.slice(0, -root.length)) return true;
    }
    return false;
  });
}

function coverCompound(covered, challenge, item) {
  const root = normalizeCompound(challenge.rootWord);
  const normalized = normalizeCompound(item);
  covered.add(normalized);
  if (challenge.position === 'prefix' || challenge.position === 'both') covered.add(root + normalized);
  if (challenge.position === 'suffix' || challenge.position === 'both') covered.add(normalized + root);
}

async function scoreCompoundChain(drillData, userResponses, providerId, model) {
  const candidates = [];
  const states = userResponses.map((r, responseIndex) => {
    const challenge = drillData.challenges?.[r.questionIndex ?? responseIndex];
    if (!challenge?.rootWord) throw new Error(`Cannot score compound-chain response ${responseIndex}: missing challenge`);
    const seen = new Set();
    const state = { challenge, validItems: [], invalidItems: [], duplicateItems: [], covered: new Set() };
    (r.items || []).forEach((item, itemIndex) => {
      const normalized = normalizeCompound(item);
      if (!normalized || normalized === normalizeCompound(challenge.rootWord)) {
        state.invalidItems.push(item);
      } else if (seen.has(normalized)) {
        state.duplicateItems.push(item);
      } else {
        seen.add(normalized);
        const example = matchedCompoundExample(challenge, item);
        if (example) {
          state.validItems.push(item);
          state.covered.add(normalizeCompound(example));
        } else {
          candidates.push({ responseIndex, itemIndex, item, rootWord: challenge.rootWord, position: challenge.position });
        }
      }
    });
    return state;
  });

  const semantic = await semanticVerdicts(
    candidates,
    `Validate these proposed compound words or common fixed phrases. A proposal is valid only if it forms a recognized compound or common phrase with the root in the stated position. Reject invented fragments and the bare root.\n\nCandidates:\n${JSON.stringify(candidates)}\n\nReturn ONLY valid JSON with exactly one verdict per candidate:\n{"verdicts":[{"responseIndex":0,"itemIndex":0,"valid":true,"reason":"common compound"}]}`,
    providerId,
    model,
    'compound-chain semantic validation response',
  );

  candidates.forEach((candidate) => {
    const state = states[candidate.responseIndex];
    if (semantic.verdicts.get(`${candidate.responseIndex}:${candidate.itemIndex}`)) {
      state.validItems.push(candidate.item);
      coverCompound(state.covered, state.challenge, candidate.item);
    } else {
      state.invalidItems.push(candidate.item);
    }
  });

  const scores = states.map((state) => {
    const target = state.challenge.minExpected;
    const validCount = state.validItems.length;
    const score = Math.round(Math.min(1, validCount / target) * 100);
    const feedback = validCount >= target
      ? `${validCount} valid compounds — great job!`
      : `${validCount} valid compound${validCount !== 1 ? 's' : ''} (target: ${target})`;
    const missedExamples = (state.challenge.examples || [])
      .filter((example) => !state.covered.has(normalizeCompound(example)));
    return {
      score, feedback, validCount, validItems: state.validItems,
      invalidItems: state.invalidItems, duplicateItems: state.duplicateItems, missedExamples,
    };
  });
  const overallScore = averageScore(scores);
  return {
    evaluation: { overallScore, scores, summary: `Average ${overallScore}% across ${scores.length} challenges` },
    kind: candidates.length ? 'hybrid' : 'local',
    providerId: semantic.providerId,
    model: semantic.model,
  };
}

function isLexicalCandidate(value) {
  const item = String(value || '').trim();
  return item.length > 0
    && item.length <= 80
    && /\p{L}/u.test(item)
    && !/[\u0000-\u001f\u007f]/u.test(item);
}

async function scoreVerbalFluency(drillData, userResponses, providerId, model) {
  const candidates = [];
  const states = userResponses.map((r, responseIndex) => {
    const category = drillData.categories?.[r.questionIndex ?? responseIndex];
    if (!category?.category) throw new Error(`Cannot score verbal-fluency response ${responseIndex}: missing category`);
    const examples = new Set((category.examples || []).map(normalizeAnswer));
    const seen = new Set();
    const state = { category, validItems: [], invalidItems: [], duplicateItems: [] };
    (r.items || []).forEach((item, itemIndex) => {
      const normalized = normalizeAnswer(item);
      if (!isLexicalCandidate(item)) {
        state.invalidItems.push(item);
      } else if (seen.has(normalized)) {
        state.duplicateItems.push(item);
      } else if (examples.has(normalized)) {
        seen.add(normalized);
        state.validItems.push(item);
      } else {
        seen.add(normalized);
        candidates.push({ responseIndex, itemIndex, item, category: category.category });
      }
    });
    return state;
  });

  const semantic = await semanticVerdicts(
    candidates,
    `Validate each unique verbal-fluency item against its category. Accept real lexical items that genuinely belong to the category; reject invented strings, category labels, commentary, and unrelated words.\n\nCandidates:\n${JSON.stringify(candidates)}\n\nReturn ONLY valid JSON with exactly one verdict per candidate:\n{"verdicts":[{"responseIndex":0,"itemIndex":0,"valid":true,"reason":"belongs to category"}]}`,
    providerId,
    model,
    'verbal-fluency semantic validation response',
  );

  candidates.forEach((candidate) => {
    const state = states[candidate.responseIndex];
    if (semantic.verdicts.get(`${candidate.responseIndex}:${candidate.itemIndex}`)) state.validItems.push(candidate.item);
    else state.invalidItems.push(candidate.item);
  });

  const scores = states.map((state) => {
    const validCount = state.validItems.length;
    const target = state.category.minExpected;
    const score = Math.round(Math.min(1, validCount / target) * 100);
    const found = new Set(state.validItems.map(normalizeAnswer));
    return {
      score,
      feedback: `${validCount} valid unique item${validCount !== 1 ? 's' : ''} (target: ${target})`,
      validCount,
      validItems: state.validItems,
      invalidItems: state.invalidItems,
      duplicateItems: state.duplicateItems,
      missedExamples: (state.category.examples || []).filter((example) => !found.has(normalizeAnswer(example))),
    };
  });
  const overallScore = averageScore(scores);
  return {
    evaluation: { overallScore, scores, summary: `Average ${overallScore}%` },
    kind: candidates.length ? 'hybrid' : 'local',
    providerId: semantic.providerId,
    model: semantic.model,
  };
}

function scoreLocalStoryRecall(drillData, userResponses) {
  const scores = userResponses.map((r, i) => {
    const questions = drillData.exercises?.[r.questionIndex ?? i]?.questions || [];
    if (questions.length === 0) throw new Error(`Cannot score story-recall response ${i}: missing questions`);
    let correct = 0;
    for (let qi = 0; qi < questions.length; qi++) {
      const accepted = [questions[qi].answer, ...(questions[qi].aliases || [])].map(normalizeAnswer);
      const given = normalizeAnswer(r.answers?.[qi]);
      if (given && accepted.includes(given)) correct++;
    }
    const score = Math.round((correct / questions.length) * 100);
    return { score, feedback: `${correct} of ${questions.length} correct` };
  });
  const overallScore = averageScore(scores);
  return { overallScore, scores, summary: `${overallScore}% recall accuracy` };
}

const LOCAL_SCORERS = {
  'bridge-word': scoreLocalBridgeWord,
  'story-recall': scoreLocalStoryRecall,
};

const HYBRID_SCORERS = {
  'compound-chain': scoreCompoundChain,
  'verbal-fluency': scoreVerbalFluency,
};

/*
 * The two open-ended validators above deliberately make one semantic request
 * for the complete response set. Known answer-key entries stay deterministic;
 * every unknown item is classified in that one bounded payload.
 */

const LLM_SCORE_BUILDERS = {
  'word-association': buildWordAssociationScorePrompt,
  'wit-comeback': buildWitComebackScorePrompt,
  'pun-wordplay': buildPunWordplayScorePrompt,
  'double-meaning': buildDoubleMeaningScorePrompt,
  'idiom-twist': buildIdiomTwistScorePrompt,
  'what-if': buildWhatIfScorePrompt,
  'alternative-uses': buildAlternativeUsesScorePrompt,
  'story-prompt': buildStoryPromptScorePrompt,
  'invention-pitch': buildInventionPitchScorePrompt,
  'reframe': buildReframeScorePrompt,
};

export async function scoreLlmDrill(type, drillData, userResponses, timeLimitMs, providerId, model) {
  const avgResponseMs = userResponses.length > 0
    ? userResponses.reduce((sum, r) => sum + (r.responseMs || 0), 0) / userResponses.length
    : timeLimitMs;
  const speedBonus = Math.max(0, 1 - avgResponseMs / timeLimitMs);

  // Fast path: score locally for drill types with deterministic answers
  const localScorer = LOCAL_SCORERS[type];
  if (localScorer) {
    console.log(`⚡ POST local scoring: ${type}`);
    const evaluation = evaluationWithProvenance(type, drillData, localScorer(drillData, userResponses), 'local');
    return buildScoringResult(evaluation, userResponses, speedBonus);
  }

  const hybridScorer = HYBRID_SCORERS[type];
  if (hybridScorer) {
    console.log(`🧪 POST evidence-based scoring: ${type}`);
    const scored = await hybridScorer(drillData, userResponses, providerId, model);
    const evaluation = evaluationWithProvenance(
      type, drillData, scored.evaluation, scored.kind, scored.providerId, scored.model,
    );
    return buildScoringResult(evaluation, userResponses, speedBonus);
  }

  // Slow path: LLM scoring for creative/subjective drills
  const builder = LLM_SCORE_BUILDERS[type];
  if (!builder) throw new Error(`Unsupported POST LLM scorer type: ${type}`);

  console.log(`🧪 POST LLM scoring: ${type}`);
  const response = await callAI(builder(drillData, userResponses), providerId, model);
  const payload = validatePostLlmScorePayload(parseJsonFromAI(response.text), userResponses.length);
  const evaluation = evaluationWithProvenance(
    type, drillData, payload, 'llm', response.providerId, response.model,
  );
  return buildScoringResult(evaluation, userResponses, speedBonus);
}

function buildWordAssociationScorePrompt(drillData, responses) {
  const pairs = responses.map((r, i) => {
    const q = drillData.questions?.[r.questionIndex ?? i];
    return `Word: "${q?.prompt}" -> User associations: "${r.response || '(no response)'}"`;
  }).join('\n');

  return `Score these word association responses for creativity, breadth, and relevance.
Rate each response 0-100 and give brief feedback.

${pairs}

Return ONLY valid JSON:
{"overallScore":75,"scores":[{"score":80,"feedback":"Good creative connections"}],"summary":"Overall assessment"}`;
}

function buildWitComebackScorePrompt(drillData, responses) {
  const items = responses.map((r, i) => {
    const scenario = drillData.scenarios?.[r.questionIndex ?? i];
    return `Setup: "${scenario?.setup}"\nContext: ${scenario?.context || 'none'}\nUser's response: "${r.response || '(no response)'}"`;
  }).join('\n\n');

  return `Score these witty comeback responses on: humor (40%), cleverness (30%), relevance to setup (30%).
Rate each 0-100 and give brief feedback.

${items}

Return ONLY valid JSON:
{"overallScore":75,"scores":[{"score":85,"feedback":"Sharp and well-timed"}],"summary":"Overall wit assessment"}`;
}

function buildPunWordplayScorePrompt(drillData, responses) {
  const items = responses.map((r, i) => {
    const challenge = drillData.challenges?.[r.questionIndex ?? i];
    return `Challenge: "${challenge?.prompt}" (topic: ${challenge?.topic})\nUser's answer: "${r.response || '(no response)'}"`;
  }).join('\n\n');

  return `Score these pun/wordplay responses on: cleverness of wordplay (40%), humor (30%), relevance to topic (30%).
Rate each 0-100 and give brief feedback on the quality of the pun or wordplay.

${items}

Return ONLY valid JSON:
{"overallScore":75,"scores":[{"score":90,"feedback":"Excellent double meaning"}],"summary":"Overall wordplay assessment"}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// WORDPLAY TRAINING SCORE PROMPTS
// ─────────────────────────────────────────────────────────────────────────────

function buildDoubleMeaningScorePrompt(drillData, responses) {
  const items = responses.map((r, i) => {
    const challenge = drillData.challenges?.[r.questionIndex ?? i];
    return `Word: "${challenge?.word}" (meanings: ${(challenge?.meanings || []).join(' / ')})\nUser's sentence: "${r.response || '(no response)'}"`;
  }).join('\n\n');

  return `Score these double meaning wordplay responses. For each challenge:
1. Does the sentence use BOTH meanings of the word? (40%)
2. Is it clever/witty? (30%)
3. Is it grammatically correct and natural-sounding? (30%)
Rate each 0-100. Penalize if only one meaning is used.

${items}

Return ONLY valid JSON:
{"overallScore":75,"scores":[{"score":85,"feedback":"Both meanings used cleverly"}],"summary":"Overall double meaning assessment"}`;
}

function buildIdiomTwistScorePrompt(drillData, responses) {
  const items = responses.map((r, i) => {
    const challenge = drillData.challenges?.[r.questionIndex ?? i];
    return `Idiom: "${challenge?.idiom}" → Domain: "${challenge?.domain}"\nUser's twist: "${r.response || '(no response)'}"`;
  }).join('\n\n');

  return `Score these idiom twist responses on: recognizable connection to original idiom (30%), relevance to new domain (30%), cleverness of wordplay (40%).
Rate each 0-100. The best twists maintain the rhythm/structure of the original while making domain-specific substitutions.

${items}

Return ONLY valid JSON:
{"overallScore":75,"scores":[{"score":85,"feedback":"Great structural parallel with clever domain substitution"}],"summary":"Overall idiom twist assessment"}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// IMAGINATION DRILL SCORE PROMPTS
// ─────────────────────────────────────────────────────────────────────────────

function buildWhatIfScorePrompt(drillData, responses) {
  const items = responses.map((r, i) => {
    const scenario = drillData.scenarios?.[r.questionIndex ?? i];
    return `Scenario: "${scenario?.prompt}"\nUser's response: "${r.response || '(no response)'}"`;
  }).join('\n\n');

  return `Score these "What If" imagination responses on: originality (35%), depth of reasoning (35%), humor/creativity (30%).
Rate each 0-100 and give brief feedback.

${items}

Return ONLY valid JSON:
{"overallScore":75,"scores":[{"score":80,"feedback":"Creative and well-reasoned"}],"summary":"Overall imagination assessment"}`;
}

function buildAlternativeUsesScorePrompt(drillData, responses) {
  const items = responses.map((r, i) => {
    const obj = drillData.objects?.[r.questionIndex ?? i];
    return `Object: "${obj?.object}" (common use: ${obj?.commonUse})\nUser's creative uses: ${(r.items || []).join(', ') || '(none)'}`;
  }).join('\n\n');

  return `Score these "Alternative Uses" divergent thinking responses. For each object:
1. Count valid, unique, creative uses (exclude the obvious common use)
2. Rate originality — unusual uses score higher than obvious ones
3. Consider feasibility — completely impossible uses score lower

${items}

Return ONLY valid JSON:
{"overallScore":75,"scores":[{"score":80,"feedback":"8 valid uses, 3 highly original","validCount":8}],"summary":"Overall divergent thinking assessment"}`;
}

function buildStoryPromptScorePrompt(drillData, responses) {
  const items = responses.map((r, i) => {
    const p = drillData.prompts?.[r.questionIndex ?? i];
    return `Words: ${(p?.words || []).join(', ')}\nUser's micro-story: "${r.response || '(no response)'}"`;
  }).join('\n\n');

  return `Score these micro-stories on: incorporates all 3 words naturally (30%), creativity/surprise (35%), coherence/quality (35%).
Rate each 0-100. Penalize if any of the 3 words are missing.

${items}

Return ONLY valid JSON:
{"overallScore":75,"scores":[{"score":85,"feedback":"All words used naturally, clever twist"}],"summary":"Overall creative writing assessment"}`;
}

function buildInventionPitchScorePrompt(drillData, responses) {
  const items = responses.map((r, i) => {
    const p = drillData.problems?.[r.questionIndex ?? i];
    return `Problem: "${p?.problem}"\nUser's invention pitch: "${r.response || '(no response)'}"`;
  }).join('\n\n');

  return `Score these invention pitches on: addresses the problem (30%), creativity/novelty (40%), feasibility (30%).
Rate each 0-100. A great pitch is both creative AND somewhat plausible.

${items}

Return ONLY valid JSON:
{"overallScore":75,"scores":[{"score":80,"feedback":"Novel approach, reasonably feasible"}],"summary":"Overall invention assessment"}`;
}

function buildReframeScorePrompt(drillData, responses) {
  const items = responses.map((r, i) => {
    const s = drillData.situations?.[r.questionIndex ?? i];
    return `Negative situation: "${s?.situation}"\nUser's reframe: "${r.response || '(no response)'}"`;
  }).join('\n\n');

  return `Score these positive reframes on: genuineness (30%), humor (30%), insight/wisdom (40%).
A great reframe finds a real silver lining, not just forced positivity.
Rate each 0-100.

${items}

Return ONLY valid JSON:
{"overallScore":75,"scores":[{"score":85,"feedback":"Genuine insight with humor"}],"summary":"Overall reframing assessment"}`;
}
