import { escapeRegExp } from './textUtils.js';

// Persisted pipeline stages, grouped by artifact shape and execution behavior.
export const TEXT_STAGE_IDS = Object.freeze(['idea', 'prose', 'comicScript', 'teleplay']);
export const VISUAL_STAGE_IDS = Object.freeze(['comicPages', 'storyboards', 'episodeVideo']);
export const AUDIO_STAGE_IDS = Object.freeze(['audio']);
export const PIPELINE_STAGE_IDS = Object.freeze([
  ...TEXT_STAGE_IDS,
  ...VISUAL_STAGE_IDS,
  ...AUDIO_STAGE_IDS,
]);

// User-visible tab order. Nouns is a UI-only workspace; comicPages is folded
// into the Comic tab even though it remains a persisted data stage.
export const PIPELINE_TAB_STAGE_IDS = Object.freeze([
  'idea',
  'prose',
  'nouns',
  'comicScript',
  'teleplay',
  'storyboards',
  'episodeVideo',
  'audio',
]);

export const PIPELINE_STAGE_LABELS = Object.freeze({
  idea: 'Idea',
  prose: 'Prose',
  nouns: 'Nouns',
  comicScript: 'Comic',
  teleplay: 'Teleplay',
  comicPages: 'Comic',
  storyboards: 'Storyboards',
  episodeVideo: 'Video',
  audio: 'Audio',
});

// Spoken aliases resolve to visible tabs. Comic-page wording therefore opens
// the merged Comic tab instead of its hidden persisted-stage URL.
export const PIPELINE_STAGE_ALIASES = Object.freeze({
  idea: 'idea',
  prose: 'prose',
  story: 'prose',
  nouns: 'nouns',
  noun: 'nouns',
  characters: 'nouns',
  'comic script': 'comicScript',
  comicscript: 'comicScript',
  comic: 'comicScript',
  comics: 'comicScript',
  'comic pages': 'comicScript',
  'comic page': 'comicScript',
  comicpages: 'comicScript',
  pages: 'comicScript',
  page: 'comicScript',
  'tv script': 'teleplay',
  tvscript: 'teleplay',
  teleplay: 'teleplay',
  storyboards: 'storyboards',
  storyboard: 'storyboards',
  scenes: 'storyboards',
  'episode video': 'episodeVideo',
  episodevideo: 'episodeVideo',
  episode: 'episodeVideo',
  video: 'episodeVideo',
  audio: 'audio',
  'voice over': 'audio',
  music: 'audio',
});

export function buildPipelineIntentRe(aliases = PIPELINE_STAGE_ALIASES) {
  const spokenStages = Object.keys(aliases)
    .sort((a, b) => b.length - a.length)
    .map((alias) => escapeRegExp(alias).replace(/\s+/g, '\\s+'))
    .join('|');
  return new RegExp(
    `\\b(?:next stage|previous stage|prev stage|stage (?:advance|forward|back)|(?:open|go to|back to)(?: the)? (?:${spokenStages})(?: stage)?)\\b`,
    'i',
  );
}
