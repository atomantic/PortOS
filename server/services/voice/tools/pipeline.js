// Creative-pipeline stage navigation voice tools: advance / go back / open a
// named stage of the current pipeline issue. These only work on a
// /pipeline/issues/... page; off-page calls return a friendly error.

import { NAVIGABLE_STAGE_IDS as PIPELINE_STAGE_IDS } from '../../pipeline/issues.js';

// Pipeline stage navigation — fires on "next stage", "previous stage",
// "back to prose", "open the storyboards", "open prose", "open teleplay",
// and the stage names + their spoken aliases (idea, prose, story,
// comic script, teleplay, comic pages, pages, storyboards, scenes,
// episode video, episode, video). The stage-name alternation is shared
// across open/go-to/back-to so users don't need to say "stage" as a
// suffix. The leading anchors keep "take me to pipeline" out of this
// group — that still routes to ui_navigate.
//
// Alias list must mirror PIPELINE_STAGE_ALIASES below so any alias
// accepted by pipeline_open_stage actually triggers the group.
export const PIPELINE_INTENT_RE = /\b(?:next stage|previous stage|prev stage|stage (?:advance|forward|back)|(?:open|go to|back to)(?: the)? (?:idea|prose|story|comic ?script|comicscript|comics|tv ?script|tvscript|teleplay|comic ?pages?|comicpages|pages?|storyboards?|scenes|episode ?video|episodevideo|episode|video)(?: stage)?)\b/i;

const PIPELINE_STAGE_LABELS = {
  idea: 'Idea',
  prose: 'Prose',
  comicScript: 'Comic Script',
  teleplay: 'Teleplay',
  comicPages: 'Comic Pages',
  storyboards: 'Storyboards',
  episodeVideo: 'Episode Video',
};
// Spoken aliases → canonical stage ids. `resolveNavCommand` covers top-level
// pages but not in-route stage names, so this is a dedicated table.
const PIPELINE_STAGE_ALIASES = {
  idea: 'idea',
  prose: 'prose', story: 'prose',
  'comic script': 'comicScript', comicscript: 'comicScript', comics: 'comicScript',
  'tv script': 'teleplay', tvscript: 'teleplay', teleplay: 'teleplay',
  'comic pages': 'comicPages', 'comic page': 'comicPages', comicpages: 'comicPages', pages: 'comicPages', page: 'comicPages',
  storyboards: 'storyboards', storyboard: 'storyboards', scenes: 'storyboards',
  'episode video': 'episodeVideo', episodevideo: 'episodeVideo', episode: 'episodeVideo', video: 'episodeVideo',
};
const parsePipelineIssuePath = (path) => {
  if (typeof path !== 'string') return null;
  // Strip query/hash before matching — `[^/]+` would otherwise greedily
  // absorb `?foo=bar` or `#anchor` into the captured id/stage segments
  // (the path "/pipeline/issues/abc?x" would parse as id="abc?x").
  const clean = path.split(/[?#]/)[0];
  const m = clean.match(/^\/pipeline\/issues\/([^/]+)(?:\/([^/]+))?/);
  if (!m) return null;
  const stage = PIPELINE_STAGE_IDS.includes(m[2]) ? m[2] : 'idea';
  return { issueId: m[1], stage };
};
const NOT_ON_PIPELINE_ISSUE_PAGE = {
  ok: false,
  error: 'Not on a pipeline issue page',
  summary: 'I can only switch stages from a /pipeline/issues/... page. Open an issue first.',
};
const navigateToPipelineStage = (issueId, stage, ctx) => {
  const path = `/pipeline/issues/${issueId}/${stage}`;
  ctx.sideEffects?.push({ type: 'navigate', path });
  return { ok: true, path, stage, label: PIPELINE_STAGE_LABELS[stage], summary: `Opened ${PIPELINE_STAGE_LABELS[stage]}.` };
};

export const PIPELINE_TOOLS = [
  {
    name: 'pipeline_next_stage',
    description: 'Advance to the next stage of the current pipeline issue (Idea → Prose → Comic Script → Teleplay → Comic Pages → Storyboards → Episode Video). Only works on a /pipeline/issues/... page.',
    parameters: { type: 'object', properties: {} },
    execute: async (_args, ctx = {}) => {
      const cur = parsePipelineIssuePath(ctx.state?.ui?.path);
      if (!cur) return NOT_ON_PIPELINE_ISSUE_PAGE;
      const idx = PIPELINE_STAGE_IDS.indexOf(cur.stage);
      if (idx === PIPELINE_STAGE_IDS.length - 1) {
        return { ok: false, error: 'Already on last stage', summary: `Already on ${PIPELINE_STAGE_LABELS[cur.stage]} — that's the last stage.` };
      }
      return navigateToPipelineStage(cur.issueId, PIPELINE_STAGE_IDS[idx + 1], ctx);
    },
  },
  {
    name: 'pipeline_prev_stage',
    description: 'Go back to the previous stage of the current pipeline issue. Only works on a /pipeline/issues/... page.',
    parameters: { type: 'object', properties: {} },
    execute: async (_args, ctx = {}) => {
      const cur = parsePipelineIssuePath(ctx.state?.ui?.path);
      if (!cur) return NOT_ON_PIPELINE_ISSUE_PAGE;
      const idx = PIPELINE_STAGE_IDS.indexOf(cur.stage);
      if (idx === 0) {
        return { ok: false, error: 'Already on first stage', summary: `Already on ${PIPELINE_STAGE_LABELS[cur.stage]} — that's the first stage.` };
      }
      return navigateToPipelineStage(cur.issueId, PIPELINE_STAGE_IDS[idx - 1], ctx);
    },
  },
  {
    name: 'pipeline_open_stage',
    description: 'Open a specific stage of the current pipeline issue by name. Pass `stage` as the user spoke it: "prose", "comic script", "storyboards", "episode video", etc. Only works on a /pipeline/issues/... page.',
    parameters: {
      type: 'object',
      properties: {
        stage: {
          type: 'string',
          description: 'Stage name (idea, prose, comic script, tv script, comic pages, storyboards, episode video).',
        },
      },
      required: ['stage'],
    },
    execute: async ({ stage } = {}, ctx = {}) => {
      const cur = parsePipelineIssuePath(ctx.state?.ui?.path);
      if (!cur) return NOT_ON_PIPELINE_ISSUE_PAGE;
      const key = String(stage || '').trim().toLowerCase();
      // Build a case-insensitive canonical lookup so "Prose", "PROSE",
      // "prose" all resolve. PIPELINE_STAGE_IDS is mixed-case ('idea',
      // 'comicScript', ...) so a direct .includes(key) wouldn't match;
      // compare lowercased forms instead.
      const canonicalById = PIPELINE_STAGE_IDS.find((id) => id.toLowerCase() === key);
      const canonical = PIPELINE_STAGE_ALIASES[key] || canonicalById || null;
      if (!canonical) {
        return {
          ok: false,
          error: `Unknown stage "${stage}"`,
          summary: `I don't know a stage named "${stage}". Try: idea, prose, comic script, tv script, comic pages, storyboards, or episode video.`,
        };
      }
      return navigateToPipelineStage(cur.issueId, canonical, ctx);
    },
  },
];
