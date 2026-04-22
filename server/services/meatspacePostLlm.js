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

import { spawn } from 'child_process';
import { getActiveProvider, getProviderById } from './providers.js';

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

async function callAI(prompt, providerId, model) {
  const provider = providerId
    ? await getProviderById(providerId)
    : await getActiveProvider();

  if (!provider?.enabled) {
    throw new Error('No AI provider available for POST drills');
  }

  const selectedModel = model || provider.defaultModel;
  console.log(`🧪 POST LLM drill: ${provider.id} / ${selectedModel}`);

  if (provider.type === 'cli') {
    return new Promise((resolve, reject) => {
      const args = [...(provider.args || [])];
      if (provider.headlessArgs?.length) args.push(...provider.headlessArgs);
      if (selectedModel) args.push('--model', selectedModel);
      args.push(prompt);
      let output = '';
      let settled = false;

      const child = spawn(provider.command, args, {
        env: (() => { const e = { ...process.env, ...(provider.envVars || {}) }; delete e.CLAUDECODE; return e; })(),
        shell: false,
        windowsHide: true
      });

      const timeoutHandle = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new Error('POST AI request timed out'));
      }, provider.timeout || 120000);

      child.stdout.on('data', d => { output += d.toString(); });
      child.stderr.on('data', d => { output += d.toString(); });
      child.on('close', code => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        code === 0 ? resolve(output) : reject(new Error(`CLI exited with code ${code}`));
      });
      child.on('error', err => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        reject(err);
      });
    });
  }

  if (provider.type === 'api') {
    const headers = { 'Content-Type': 'application/json' };
    if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`;

    const response = await fetch(`${provider.endpoint}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: selectedModel,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7
      }),
      signal: AbortSignal.timeout(provider.timeout || 120000)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`AI API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  }

  throw new Error(`Unsupported provider type: ${provider.type}`);
}

function parseJsonFromAI(content) {
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

  const response = await callAI(prompt, providerId, model);
  const data = parseJsonFromAI(response);
  return {
    type: 'word-association',
    config: { count },
    questions: (data.questions || []).slice(0, count).map(q => ({
      prompt: q.prompt,
      hints: q.hints || ''
    }))
  };
}

export async function generateStoryRecall(config, providerId, model) {
  const count = config.count || 3;
  const prompt = `Generate ${count} short story recall exercises for cognitive training.
Each exercise has a short paragraph (2-4 sentences) containing specific details: names, numbers, places, colors, dates.
Then provide 3-4 recall questions about those details, each with a correct answer.

Return ONLY valid JSON:
{"exercises":[{"paragraph":"The story text...","questions":[{"question":"What was the name...?","answer":"correct answer"}]}]}

Make paragraphs vivid and varied. Include specific numbers, proper nouns, and concrete details.`;

  const response = await callAI(prompt, providerId, model);
  const data = parseJsonFromAI(response);
  return {
    type: 'story-recall',
    config: { count },
    exercises: (data.exercises || []).slice(0, count)
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

  const response = await callAI(prompt, providerId, model);
  const data = parseJsonFromAI(response);
  return {
    type: 'verbal-fluency',
    config: { count },
    categories: (data.categories || []).slice(0, count)
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

  const response = await callAI(prompt, providerId, model);
  const data = parseJsonFromAI(response);
  return {
    type: 'wit-comeback',
    config: { count },
    scenarios: (data.scenarios || []).slice(0, count)
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

  const response = await callAI(prompt, providerId, model);
  const data = parseJsonFromAI(response);
  return {
    type: 'pun-wordplay',
    config: { count },
    challenges: (data.challenges || []).slice(0, count)
  };
}

export async function generateWhatIf(config, providerId, model) {
  const count = config.count || 3;
  const prompt = `Generate ${count} creative "What If" hypothetical scenarios for imagination training.
Each scenario should be absurd, thought-provoking, and fun to reason about.
Mix science, society, nature, and everyday life. Be creative and specific.

Return ONLY valid JSON:
{"scenarios":[{"prompt":"What if gravity reversed for 10 minutes every Tuesday?","category":"physics"}]}`;

  const response = await callAI(prompt, providerId, model);
  const data = parseJsonFromAI(response);
  return {
    type: 'what-if',
    config: { count },
    scenarios: (data.scenarios || []).slice(0, count)
  };
}

export async function generateAlternativeUses(config, providerId, model) {
  const count = config.count || 3;
  const prompt = `Generate ${count} "Alternative Uses" challenges for divergent thinking training.
Each challenge names a common everyday object. The user must list creative, unusual uses for it.
Pick objects that have many possible creative uses.

Return ONLY valid JSON:
{"objects":[{"object":"brick","commonUse":"building material","minExpected":8}]}`;

  const response = await callAI(prompt, providerId, model);
  const data = parseJsonFromAI(response);
  return {
    type: 'alternative-uses',
    config: { count },
    objects: (data.objects || []).slice(0, count)
  };
}

export async function generateStoryPrompt(config, providerId, model) {
  const count = config.count || 3;
  const prompt = `Generate ${count} "Story Prompt" challenges for creative writing training.
Each challenge gives exactly 3 random, unrelated words. The user must write a micro-story (2-4 sentences) connecting all three words.
Choose words that are surprising when combined.

Return ONLY valid JSON:
{"prompts":[{"words":["lighthouse","saxophone","marmalade"]}]}`;

  const response = await callAI(prompt, providerId, model);
  const data = parseJsonFromAI(response);
  return {
    type: 'story-prompt',
    config: { count },
    prompts: (data.prompts || []).slice(0, count)
  };
}

export async function generateInventionPitch(config, providerId, model) {
  const count = config.count || 3;
  const prompt = `Generate ${count} "Invention Pitch" challenges for creative problem-solving training.
Each challenge describes a specific, relatable problem. The user must pitch an inventive solution in 2-3 sentences.
Mix everyday annoyances, workplace challenges, and social problems.

Return ONLY valid JSON:
{"problems":[{"problem":"You always forget where you put your keys","category":"everyday","difficulty":"easy"}]}`;

  const response = await callAI(prompt, providerId, model);
  const data = parseJsonFromAI(response);
  return {
    type: 'invention-pitch',
    config: { count },
    problems: (data.problems || []).slice(0, count)
  };
}

export async function generateReframe(config, providerId, model) {
  const count = config.count || 3;
  const prompt = `Generate ${count} "Reframe" challenges for positive thinking and humor training.
Each challenge describes a frustrating or negative situation. The user must reframe it positively, humorously, or find a silver lining.
Mix minor annoyances with bigger setbacks. Keep them relatable.

Return ONLY valid JSON:
{"situations":[{"situation":"Your flight was delayed by 4 hours","severity":"medium"}]}`;

  const response = await callAI(prompt, providerId, model);
  const data = parseJsonFromAI(response);
  return {
    type: 'reframe',
    config: { count },
    situations: (data.situations || []).slice(0, count)
  };
}

export async function generateCompoundChain(config, providerId, model) {
  const count = config.count || 5;
  const prompt = `Generate ${count} compound word/phrase association challenges for verbal training.
For each challenge, provide a root word that appears in many compound words or common phrases.
Choose words with at least 10+ valid compound combinations (as prefix or suffix).
Mix common roots (fire, back, hand) with less obvious ones (cross, break, light).

Return ONLY valid JSON (no markdown, no explanation):
{"challenges":[{"rootWord":"paper","position":"prefix","examples":["paperback","paper trail","paperweight","paper clip","paper thin"],"minExpected":8}]}

position is "prefix" if the root starts the compound (firehouse), "suffix" if it ends it (campfire), or "both" if common either way (light→lighthouse, flashlight).
The examples field should contain 10-15 sample answers for reference. minExpected is the target count.`;

  const response = await callAI(prompt, providerId, model);
  const data = parseJsonFromAI(response);
  return {
    type: 'compound-chain',
    config: { count },
    challenges: (data.challenges || []).slice(0, count).map(c => ({
      rootWord: c.rootWord,
      position: c.position || 'both',
      examples: c.examples || [],
      minExpected: c.minExpected || 8,
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

  const response = await callAI(prompt, providerId, model);
  const data = parseJsonFromAI(response);
  return {
    type: 'bridge-word',
    config: { count },
    puzzles: (data.puzzles || []).slice(0, count).map(p => ({
      clues: p.clues || [],
      answer: p.answer,
      difficulty: p.difficulty || 'medium',
      hint: p.hint || '',
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

  const response = await callAI(prompt, providerId, model);
  const data = parseJsonFromAI(response);
  return {
    type: 'double-meaning',
    config: { count },
    challenges: (data.challenges || []).slice(0, count).map(c => ({
      word: c.word,
      meanings: c.meanings || [],
      example: c.example || '',
      difficulty: c.difficulty || 'medium',
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

  const response = await callAI(prompt, providerId, model);
  const data = parseJsonFromAI(response);
  return {
    type: 'idiom-twist',
    config: { count },
    challenges: (data.challenges || []).slice(0, count).map(c => ({
      idiom: c.idiom,
      domain: c.domain,
      example: c.example || '',
      difficulty: c.difficulty || 'medium',
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
  const qualityScore = Math.min(100, Math.max(0, evaluation.overallScore || 0));
  const finalScore = Math.min(100, Math.max(0, Math.round(qualityScore * 0.8 + speedBonus * 0.2 * 100)));
  return {
    score: finalScore,
    evaluation,
    questions: userResponses.map((r, i) => ({
      ...r,
      llmScore: evaluation.scores?.[i]?.score ?? null,
      llmFeedback: evaluation.scores?.[i]?.feedback ?? ''
    }))
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LOCAL (INSTANT) SCORING — no LLM call needed
// ─────────────────────────────────────────────────────────────────────────────

function scoreLocalBridgeWord(drillData, userResponses) {
  const scores = userResponses.map((r, i) => {
    const puzzle = drillData.puzzles?.[r.questionIndex ?? i];
    if (!puzzle?.answer) return { score: 0, feedback: 'No answer available' };
    const userAnswer = (r.response || '').trim().toLowerCase();
    const correct = puzzle.answer.trim().toLowerCase();
    const isCorrect = userAnswer === correct;
    return {
      score: isCorrect ? 100 : 0,
      feedback: isCorrect ? 'Correct!' : `The answer was "${puzzle.answer}"`,
    };
  });
  const overallScore = averageScore(scores);
  return { overallScore, scores, summary: `${scores.filter(s => s.score === 100).length} of ${scores.length} correct` };
}

function scoreLocalCompoundChain(drillData, userResponses) {
  const scores = userResponses.map((r, i) => {
    const challenge = drillData.challenges?.[r.questionIndex ?? i];
    if (!challenge?.rootWord) return { score: 0, feedback: 'No root word', validCount: 0, invalidItems: [], missedExamples: [] };
    const root = challenge.rootWord.toLowerCase();
    const norm = s => s.toLowerCase().replace(/[\s-]/g, '');
    const seen = new Set();
    const valid = [];
    const invalid = [];
    // The "covered" set is the canonical full-compound form for each accepted
    // item: typing "firehouse" or just "house" both contribute "firehouse" so
    // missedExamples can suppress duplicates regardless of how the user typed it.
    const coveredFull = new Set();
    for (const item of (r.items || [])) {
      const lower = norm(item);
      if (!lower || seen.has(lower)) continue;
      seen.add(lower);
      if (lower === root) {
        // Bare root word is not itself a compound — reject.
        invalid.push(item);
        continue;
      }
      if (lower.includes(root)) {
        // Full compound already containing the root (e.g., "firehouse", "campfire").
        valid.push(item);
        coveredFull.add(lower);
      } else {
        // Half-compound shorthand: assume the user means root+item or item+root
        // (e.g., "hose" → firehose). We can't validate against a dictionary
        // without an LLM call, so accept it and let the user keep momentum.
        valid.push(item);
        coveredFull.add(root + lower);
        coveredFull.add(lower + root);
      }
    }
    const target = challenge.minExpected || 8;
    const score = Math.round(Math.min(1, valid.length / target) * 100);
    const fb = valid.length >= target
      ? `${valid.length} valid compounds — great job!`
      : `${valid.length} valid compound${valid.length !== 1 ? 's' : ''} (target: ${target})`;
    // Show examples the user didn't find. `coveredFull` already contains the
    // user's valid compounds plus `root+half`/`half+root` pairings, so a single
    // membership check covers both full-compound and half-word inputs.
    const missedExamples = (challenge.examples || []).filter(ex => !coveredFull.has(norm(ex)));
    return { score, feedback: fb, validCount: valid.length, invalidItems: invalid, missedExamples };
  });
  const overallScore = averageScore(scores);
  return { overallScore, scores, summary: `Average ${overallScore}% across ${scores.length} challenges` };
}

function scoreLocalVerbalFluency(drillData, userResponses) {
  const scores = userResponses.map((r, i) => {
    const cat = drillData.categories?.[r.questionIndex ?? i];
    const seen = new Set();
    for (const item of (r.items || [])) seen.add(item.toLowerCase().trim());
    const uniqueCount = seen.size;
    const target = cat?.minExpected || 15;
    const score = Math.round(Math.min(1, uniqueCount / target) * 100);
    const missedExamples = (cat?.examples || []).filter(ex => !seen.has(ex.toLowerCase().trim()));
    return {
      score,
      feedback: `${uniqueCount} unique item${uniqueCount !== 1 ? 's' : ''} (target: ${target})`,
      validCount: uniqueCount,
      invalidItems: [],
      missedExamples,
    };
  });
  const overallScore = averageScore(scores);
  return { overallScore, scores, summary: `Average ${overallScore}%` };
}

function scoreLocalStoryRecall(drillData, userResponses) {
  const scores = userResponses.map((r, i) => {
    const questions = drillData.exercises?.[r.questionIndex ?? i]?.questions || [];
    if (questions.length === 0) return { score: 0, feedback: 'No questions' };
    let correct = 0;
    for (let qi = 0; qi < questions.length; qi++) {
      const expected = (questions[qi].answer || '').toLowerCase().trim();
      const given = (r.answers?.[qi] || '').toLowerCase().trim();
      if (given && (given === expected || expected.includes(given) || given.includes(expected))) {
        correct++;
      }
    }
    const score = Math.round((correct / questions.length) * 100);
    return { score, feedback: `${correct} of ${questions.length} correct` };
  });
  const overallScore = averageScore(scores);
  return { overallScore, scores, summary: `${overallScore}% recall accuracy` };
}

const LOCAL_SCORERS = {
  'bridge-word': scoreLocalBridgeWord,
  'compound-chain': scoreLocalCompoundChain,
  'verbal-fluency': scoreLocalVerbalFluency,
  'story-recall': scoreLocalStoryRecall,
};

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
    return buildScoringResult(localScorer(drillData, userResponses), userResponses, speedBonus);
  }

  // Slow path: LLM scoring for creative/subjective drills
  const builder = LLM_SCORE_BUILDERS[type];
  if (!builder) return { score: 0, evaluation: null, questions: userResponses };

  console.log(`🧪 POST LLM scoring: ${type}`);
  const response = await callAI(builder(drillData, userResponses), providerId, model);
  return buildScoringResult(parseJsonFromAI(response), userResponses, speedBonus);
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

function buildStoryRecallScorePrompt(drillData, responses) {
  const items = responses.map((r, i) => {
    const exercise = drillData.exercises?.[r.questionIndex ?? i];
    const qas = (exercise?.questions || []).map((q, qi) => {
      const userAnswer = r.answers?.[qi] || '(no answer)';
      return `  Q: ${q.question} | Correct: ${q.answer} | User: ${userAnswer}`;
    }).join('\n');
    return `Story ${i + 1}: "${exercise?.paragraph}"\n${qas}`;
  }).join('\n\n');

  return `Score these story recall responses. For each question, determine if the user's answer matches the correct answer (allow minor spelling/phrasing differences).
Rate each exercise 0-100 based on accuracy.

${items}

Return ONLY valid JSON:
{"overallScore":75,"scores":[{"score":80,"feedback":"Recalled 3 of 4 details correctly"}],"summary":"Overall memory assessment"}`;
}

function buildVerbalFluencyScorePrompt(drillData, responses) {
  const items = responses.map((r, i) => {
    const cat = drillData.categories?.[r.questionIndex ?? i];
    return `Category: "${cat?.category}" (expected ~${cat?.minExpected})\nUser items: ${(r.items || []).join(', ') || '(none)'}`;
  }).join('\n\n');

  return `Score these verbal fluency responses. For each category:
1. Count valid, unique items (remove duplicates and invalid entries)
2. Compare count to minExpected
3. Note any particularly creative or unusual valid answers

${items}

Return ONLY valid JSON:
{"overallScore":75,"scores":[{"score":80,"feedback":"Named 12 valid animals, good variety","validCount":12,"invalidItems":["rock"]}],"summary":"Overall fluency assessment"}`;
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

function buildCompoundChainScorePrompt(drillData, responses) {
  const items = responses.map((r, i) => {
    const challenge = drillData.challenges?.[r.questionIndex ?? i];
    return `Root word: "${challenge?.rootWord}" (position: ${challenge?.position}, target: ${challenge?.minExpected}+)\nUser's compounds: ${(r.items || []).join(', ') || '(none)'}`;
  }).join('\n\n');

  return `Score these compound word/phrase association responses. For each root word:
1. Count valid compound words or common phrases that actually use the root word
2. Remove duplicates, misspellings, and invalid entries (words that don't form real compounds with the root)
3. Compare count to the target (minExpected)
4. Bonus for creative or unusual but valid compounds

${items}

Return ONLY valid JSON:
{"overallScore":75,"scores":[{"score":80,"feedback":"12 valid compounds, good variety","validCount":12,"invalidItems":["not-a-real-compound"]}],"summary":"Overall compound chain assessment"}`;
}

function buildBridgeWordScorePrompt(drillData, responses) {
  const items = responses.map((r, i) => {
    const puzzle = drillData.puzzles?.[r.questionIndex ?? i];
    return `Clues: ${(puzzle?.clues || []).join(', ')}\nCorrect answer: "${puzzle?.answer}"\nUser's answer: "${r.response || '(no response)'}"`;
  }).join('\n\n');

  return `Score these bridge word puzzle responses. For each puzzle:
1. Check if the user's answer matches the correct bridge word (allow minor spelling differences)
2. If the user gave a different word that also validly fills all the blanks, give full credit
3. Rate 0 for wrong answers, 100 for correct

${items}

Return ONLY valid JSON:
{"overallScore":75,"scores":[{"score":100,"feedback":"Correct!"}],"summary":"Overall bridge word assessment"}`;
}

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
