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
  'pun-wordplay'
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
        env: (() => { const e = { ...process.env, ...provider.envVars }; delete e.CLAUDECODE; return e; })(),
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
      })
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
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) jsonStr = jsonMatch[1].trim();
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
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM SCORING
// ─────────────────────────────────────────────────────────────────────────────

export async function scoreLlmDrill(type, drillData, userResponses, timeLimitMs, providerId, model) {
  const avgResponseMs = userResponses.length > 0
    ? userResponses.reduce((sum, r) => sum + (r.responseMs || 0), 0) / userResponses.length
    : timeLimitMs;
  const speedBonus = Math.max(0, 1 - avgResponseMs / timeLimitMs);

  let scorePrompt;

  switch (type) {
    case 'word-association':
      scorePrompt = buildWordAssociationScorePrompt(drillData, userResponses);
      break;
    case 'story-recall':
      scorePrompt = buildStoryRecallScorePrompt(drillData, userResponses);
      break;
    case 'verbal-fluency':
      scorePrompt = buildVerbalFluencyScorePrompt(drillData, userResponses);
      break;
    case 'wit-comeback':
      scorePrompt = buildWitComebackScorePrompt(drillData, userResponses);
      break;
    case 'pun-wordplay':
      scorePrompt = buildPunWordplayScorePrompt(drillData, userResponses);
      break;
    default:
      return { score: 0, evaluation: null, questions: userResponses };
  }

  const response = await callAI(scorePrompt, providerId, model);
  const evaluation = parseJsonFromAI(response);

  // Combine LLM quality score (80%) with speed bonus (20%)
  const qualityScore = Math.min(100, Math.max(0, evaluation.overallScore || 0));
  const finalScore = Math.round(qualityScore * 0.8 + speedBonus * 0.2 * 100);

  return {
    score: Math.min(100, Math.max(0, finalScore)),
    evaluation,
    questions: userResponses.map((r, i) => ({
      ...r,
      llmScore: evaluation.scores?.[i]?.score ?? null,
      llmFeedback: evaluation.scores?.[i]?.feedback ?? ''
    }))
  };
}

function buildWordAssociationScorePrompt(drillData, responses) {
  const pairs = responses.map((r, i) => {
    const q = drillData.questions?.[i];
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
    const exercise = drillData.exercises?.[i];
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
    const cat = drillData.categories?.[i];
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
    const scenario = drillData.scenarios?.[i];
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
    const challenge = drillData.challenges?.[i];
    return `Challenge: "${challenge?.prompt}" (topic: ${challenge?.topic})\nUser's answer: "${r.response || '(no response)'}"`;
  }).join('\n\n');

  return `Score these pun/wordplay responses on: cleverness of wordplay (40%), humor (30%), relevance to topic (30%).
Rate each 0-100 and give brief feedback on the quality of the pun or wordplay.

${items}

Return ONLY valid JSON:
{"overallScore":75,"scores":[{"score":90,"feedback":"Excellent double meaning"}],"summary":"Overall wordplay assessment"}`;
}
