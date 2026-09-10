// Creative-pipeline stage navigation voice tools: advance / go back / open a
// named stage of the current pipeline issue. These only work on a
// /pipeline/issues/... page; off-page calls return a friendly error.

import {
  buildPipelineIntentRe,
  PIPELINE_STAGE_ALIASES,
  PIPELINE_STAGE_LABELS,
  PIPELINE_TAB_STAGE_IDS,
} from '../../../lib/pipelineStages.js';

// Pipeline stage navigation — fires on "next stage", "previous stage",
// "back to prose", "open the storyboards", "open prose", "open teleplay",
// and every stage name + spoken alias declared in pipelineStages.js. The
// stage-name alternation is derived from that table and shared
// across open/go-to/back-to so users don't need to say "stage" as a
// suffix. The leading anchors keep "take me to pipeline" out of this
// group — that still routes to ui_navigate.
//
export const PIPELINE_INTENT_RE = buildPipelineIntentRe();
const parsePipelineIssuePath = (path) => {
  if (typeof path !== 'string') return null;
  // Strip query/hash before matching — `[^/]+` would otherwise greedily
  // absorb `?foo=bar` or `#anchor` into the captured id/stage segments
  // (the path "/pipeline/issues/abc?x" would parse as id="abc?x").
  const clean = path.split(/[?#]/)[0];
  const m = clean.match(/^\/pipeline\/issues\/([^/]+)(?:\/([^/]+))?/);
  if (!m) return null;
  // Older bookmarks may still point at the hidden comicPages data-stage URL.
  // Treat it as the merged Comic tab so relative navigation stays intuitive.
  const requestedStage = m[2] === 'comicPages' ? 'comicScript' : m[2];
  const stage = PIPELINE_TAB_STAGE_IDS.includes(requestedStage) ? requestedStage : 'idea';
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
    description: 'Advance to the next visible stage of the current pipeline issue (Idea → Prose → Nouns → Comic → Teleplay → Storyboards → Video → Audio). Only works on a /pipeline/issues/... page.',
    parameters: { type: 'object', properties: {} },
    execute: async (_args, ctx = {}) => {
      const cur = parsePipelineIssuePath(ctx.state?.ui?.path);
      if (!cur) return NOT_ON_PIPELINE_ISSUE_PAGE;
      const idx = PIPELINE_TAB_STAGE_IDS.indexOf(cur.stage);
      if (idx === PIPELINE_TAB_STAGE_IDS.length - 1) {
        return { ok: false, error: 'Already on last stage', summary: `Already on ${PIPELINE_STAGE_LABELS[cur.stage]} — that's the last stage.` };
      }
      return navigateToPipelineStage(cur.issueId, PIPELINE_TAB_STAGE_IDS[idx + 1], ctx);
    },
  },
  {
    name: 'pipeline_prev_stage',
    description: 'Go back to the previous stage of the current pipeline issue. Only works on a /pipeline/issues/... page.',
    parameters: { type: 'object', properties: {} },
    execute: async (_args, ctx = {}) => {
      const cur = parsePipelineIssuePath(ctx.state?.ui?.path);
      if (!cur) return NOT_ON_PIPELINE_ISSUE_PAGE;
      const idx = PIPELINE_TAB_STAGE_IDS.indexOf(cur.stage);
      if (idx === 0) {
        return { ok: false, error: 'Already on first stage', summary: `Already on ${PIPELINE_STAGE_LABELS[cur.stage]} — that's the first stage.` };
      }
      return navigateToPipelineStage(cur.issueId, PIPELINE_TAB_STAGE_IDS[idx - 1], ctx);
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
          description: 'Stage name (idea, prose, nouns, comic script, tv script, storyboards, episode video, audio).',
        },
      },
      required: ['stage'],
    },
    execute: async ({ stage } = {}, ctx = {}) => {
      const cur = parsePipelineIssuePath(ctx.state?.ui?.path);
      if (!cur) return NOT_ON_PIPELINE_ISSUE_PAGE;
      const key = String(stage || '').trim().toLowerCase();
      // Build a case-insensitive canonical lookup so "Prose", "PROSE",
      // "prose" all resolve. PIPELINE_TAB_STAGE_IDS is mixed-case ('idea',
      // 'comicScript', ...) so a direct .includes(key) wouldn't match;
      // compare lowercased forms instead.
      const canonicalById = PIPELINE_TAB_STAGE_IDS.find((id) => id.toLowerCase() === key);
      const canonical = PIPELINE_STAGE_ALIASES[key] || canonicalById || null;
      if (!canonical) {
        return {
          ok: false,
          error: `Unknown stage "${stage}"`,
          summary: `I don't know a stage named "${stage}". Try: idea, prose, nouns, comic script, tv script, storyboards, episode video, or audio.`,
        };
      }
      return navigateToPipelineStage(cur.issueId, canonical, ctx);
    },
  },
];
