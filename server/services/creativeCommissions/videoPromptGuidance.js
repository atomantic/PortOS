/**
 * Prompt-writing guidance for video commissions.
 *
 * This is intentionally guidance for the Creative Director, not a prompt
 * rewriter. The director still owns the creative choices; this supplies the
 * production details that make those choices actionable to a renderer.
 */

const MINIMAX_H3_MODEL_PATTERN = /(?:^|[_-])minimax(?:[_-])?h3(?:[_-]|$)|minimax_h3/i;
const HAILUO_MODEL_PATTERN = /hailuo/i;

export const GENERIC_VIDEO_PROMPT_GUIDANCE = [
  'Write a production-ready prompt for one continuous shot, not a vague mood board.',
  'Specify the subject and distinctive appearance, environment, time of day, lighting, composition, and visual style.',
  'Describe an observable beginning, middle, and end: what moves, how it moves, and what has changed by the final moment.',
  'Choose one primary camera behavior and state its framing and speed; keep the action physically plausible and focused.',
  'Prefer concrete nouns and visible verbs over adjectives such as beautiful, cinematic, or dynamic by themselves.',
  'For image-to-video or continuation renders, describe motion and scene evolution from the source frame instead of re-describing a replacement image.',
].join(' ');

export const MINIMAX_H3_VIDEO_PROMPT_GUIDANCE = [
  'MiniMax H3 prompt template: expand the brief in this order — output goal and duration, subjects/assets and reference mapping, chronological timeline, scene/environment, camera (shot size, angle, movement, focus, cuts), look (style, color, texture, mood, pacing), sound, and continuity/artifact constraints.',
  'For image-to-video or continuation, treat the supplied image as the opening state and describe how the subject and camera move from it; do not replace it with a new still-image description.',
  'Use one causal action beat per shot. Give it an exact beginning, preparation, core action, settle/hold, and locked end state; keep actions physically achievable in the selected 4–15 second duration.',
  'When there are ordered references, name them in order and use a contiguous master timeline plus timestamped micro-beats with no gaps or overlaps. The next shot must inherit the prior shot’s locked pose, gaze, prop ownership, spatial relationship, and camera side.',
  'Use explicit natural-language camera direction with movement type, amplitude, and speed. Do not silently add brands, dialogue, text overlays, or unrelated actions.',
  'Keep the final MiniMax H3 render prompt under 7000 characters.',
].join(' ');

export const HAILUO_VIDEO_PROMPT_GUIDANCE = [
  'MiniMax Hailuo prompt recipe: use a concise shot description with explicit temporal progression and a single clear subject action.',
  'For image-to-video, treat the input image as the opening frame and describe only how the scene develops from it.',
  'Use explicit camera commands when useful: [Static shot], [Tracking shot], [Pan left], [Pan right], [Push in], [Pull out], [Tilt up], [Tilt down], [Zoom in], or [Zoom out]. Sequence distinct movements in order, and combine no more than three commands in one bracket.',
  'Include the subject action, camera movement, timing or progression, lighting/atmosphere, and intended final beat. Keep the final render prompt under MiniMax’s 2000-character prompt limit.',
].join(' ');

export function buildVideoPromptGuidance(modelId) {
  const normalized = typeof modelId === 'string' ? modelId.trim() : '';
  const modelLine = MINIMAX_H3_MODEL_PATTERN.test(normalized)
    ? MINIMAX_H3_VIDEO_PROMPT_GUIDANCE
    : (HAILUO_MODEL_PATTERN.test(normalized)
      ? HAILUO_VIDEO_PROMPT_GUIDANCE
      : 'If the selected model has a documented prompt grammar, follow that model grammar while preserving this shot structure.');
  return `Video prompt guidance: ${GENERIC_VIDEO_PROMPT_GUIDANCE} ${modelLine}`;
}
