/**
 * Autonomous Music Video — the creative-brief LLM step.
 *
 * One call turns the operator's free-text prompt into everything the later
 * stages need that is not the lyrics: the song title, a musical description
 * (the lyric writer's input), a compact Suno style line, the visual concept,
 * and a mood-board spec (name, notes, a composite look prompt and what to
 * avoid). Sanitizing is strict — every field is length-bounded and a missing or
 * wrong-typed field falls back to something derived from the prompt, so a thin
 * model answer degrades the board rather than failing the run.
 *
 * Runs only inside an explicit autonomous run (AI Provider Usage Policy): the
 * run is a user-started or scheduled automation, never boot-time work.
 */

import { ServerError } from '../../lib/errorHandler.js';
import { trimTo } from '../../lib/textUtils.js';
import { SUNO_LIMITS } from '../../lib/musicVideoAutonomous.js';
import { parseLLMJSON } from '../aiProvider.js';
import { assertProvider, resolveProviderAndModel, runPromptThroughProvider } from '../promptRunner.js';

const NOTE_MAX = 600;
const NOTES_MAX = 10;

function buildBriefPrompt({ prompt, guidance, instrumental }) {
  return `You are the creative director for a fully autonomous music video. From the operator's idea below, design the song AND the look of its video.

Idea:
${prompt}
${guidance ? `\nOperator guidance:\n${guidance}\n` : ''}
${instrumental ? 'The song is INSTRUMENTAL: no vocals.\n' : ''}
Return JSON only, with exactly these keys:
{
  "title": "a short, evocative song title (max 6 words)",
  "musicalDescription": "2-4 sentences: genre and subgenres, mood and emotional arc, tempo feel, instrumentation, vocal character${instrumental ? ' (instrumental)' : ''}, production. No lyrics.",
  "sunoStyle": "a comma-separated Suno style prompt, at most ${Math.floor(SUNO_LIMITS.style * 0.9)} characters: genres, mood, tempo, instruments, vocal type, production words. No artist names.",
  "concept": {
    "prompt": "2-4 sentences: the visual story or world of the video, who/what we see, how it evolves with the song",
    "style": "one line: the overall visual style"
  },
  "moodBoard": {
    "name": "a short board name",
    "description": "1-2 sentences describing the board's through-line",
    "notes": ["5-8 short, concrete visual reference notes: palette, lighting, texture, camera, era, setting, motifs"],
    "stylePrompt": "one ready-to-render paragraph describing the consistent look (medium, palette, lighting, composition, finish)",
    "negativePrompt": "comma-separated things the look must avoid"
  }
}
Keep every value original and concrete; do not copy existing song lyrics.`;
}

/** Sanitize a parsed brief; absent/invalid fields fall back to prompt-derived text. */
function sanitizeBrief(parsed, { prompt }) {
  const root = parsed && typeof parsed === 'object' ? parsed : {};
  const seed = trimTo(prompt.replace(/\s+/g, ' ').trim(), 4000);
  const title = trimTo(root.title, SUNO_LIMITS.title) || trimTo(seed, 48) || 'Untitled';
  const board = root.moodBoard && typeof root.moodBoard === 'object' ? root.moodBoard : {};
  const concept = root.concept && typeof root.concept === 'object' ? root.concept : {};
  const notes = (Array.isArray(board.notes) ? board.notes : [])
    .map((n) => trimTo(n, NOTE_MAX)).filter(Boolean).slice(0, NOTES_MAX);
  return {
    title,
    musicalDescription: trimTo(root.musicalDescription, 4000) || seed,
    sunoStyle: trimTo(root.sunoStyle, SUNO_LIMITS.style) || trimTo(seed, 200),
    concept: {
      prompt: trimTo(concept.prompt, 4000) || seed,
      style: trimTo(concept.style, 2000),
    },
    moodBoard: {
      name: trimTo(board.name, 200) || title,
      description: trimTo(board.description, 2000) || seed.slice(0, 500),
      notes,
      stylePrompt: trimTo(board.stylePrompt, 4000),
      negativePrompt: trimTo(board.negativePrompt, 2000),
    },
  };
}

export async function draftCreativeBrief({ prompt, guidance = '', instrumental = false, providerId, model, effort } = {}) {
  const { provider, selectedModel } = await resolveProviderAndModel({ providerId, model });
  assertProvider(provider, { message: 'No AI provider available to draft the music video brief', code: 'NO_PROVIDER' });
  const result = await runPromptThroughProvider({
    provider,
    model: selectedModel,
    ...(effort ? { effort } : {}),
    prompt: buildBriefPrompt({ prompt, guidance, instrumental }),
    source: 'music-video-autonomous-brief',
  });
  let parsed;
  try {
    parsed = parseLLMJSON(result.text || '');
  } catch (err) {
    throw new ServerError(`The model returned an invalid creative brief: ${err.message}`, { status: 502, code: 'BRIEF_BAD_JSON' });
  }
  const brief = sanitizeBrief(parsed, { prompt });
  console.log(`🎬 Autonomous music video brief drafted via ${provider.id}/${result.model || 'default'}: "${brief.title}"`);
  return { brief, llm: { provider: provider.id, model: result.model || null } };
}

export const __testing = { buildBriefPrompt, sanitizeBrief };
