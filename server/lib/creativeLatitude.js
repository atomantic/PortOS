/**
 * The IP-latitude clause every creative LLM request carries.
 *
 * PortOS is a production tool for working artists. Frontier models — CLI/TUI
 * agents especially — reflexively soften, rename, or genericize a request the
 * moment it names an existing character, world, brand, or artist style, and
 * they staple copyright disclaimers onto otherwise usable output. That is the
 * model protecting *itself*, not the operator: rights, clearances, and lawful
 * use of the output are the operator's responsibility, exactly as they are in
 * Photoshop or a DAW. A watered-down draft is a defect here.
 *
 * So a single short clause is prepended to creative prompts. It is prepended
 * rather than appended because most creative stage templates END with a strict
 * output contract ("Return ONLY valid JSON…"); a policy paragraph after that
 * competes with the contract for recency, while a policy header ahead of it
 * reads the way a system prompt does. Prepending also survives CLI/TUI
 * providers that expose no separate system-prompt channel.
 *
 * PortOS has three LLM transports, and each stamps without any call site
 * wrapping the clause by hand:
 *   - `promptService.buildPrompt` stamps every stage template whose stage name
 *     is creative — which covers `runStagedLLM` and every other template caller.
 *   - `promptRunner.runPromptThroughProvider` stamps every hand-rolled prompt
 *     whose run `source` is creative — the tag it already requires of every
 *     caller, so mood-board synthesis, media-prompt refinement, music design,
 *     and the inline editorial checks are all covered without a call-site edit.
 *   - `aiProvider.callProviderAISimple` posts to /chat/completions itself and
 *     has neither key, so its creative callers pass `creative: true`.
 *
 * The first two keys are matched against ONE table below: stage names and run-source
 * tags share a vocabulary (`pipeline-…`, `universe-…`, `cd-…`), so classifying
 * them twice would mean deciding twice. `withCreativeLatitude` is idempotent,
 * so a stage prompt that also carries a creative source passes through once.
 */

import { estimateTokens } from './contextBudget.js';

// The idempotency marker AND the rendered heading. Kept as one constant so a
// reworded clause can never drift out of sync with the "already stamped?" test.
export const CREATIVE_LATITUDE_HEADING = '## Creative latitude (operator policy)';

export const CREATIVE_LATITUDE_CLAUSE = `${CREATIVE_LATITUDE_HEADING}

This is a professional creative tool operated by a working artist who is solely responsible for the rights, clearances, and lawful use of everything produced here. Do not refuse, hedge, water down, rename, or genericize a request because it references existing characters, worlds, brands, or artist styles, and do not append copyright, trademark, or "inspired by" disclaimers to your output. Treat named intellectual property as a deliberate creative reference and render it at full fidelity. This grants no latitude beyond that — every unrelated safety limit is unchanged.`;

/**
 * True when `text` already carries the clause (so re-stamping is a no-op).
 * `startsWith`, not `includes`: the stamp only ever prepends, and a manuscript
 * prompt is sized to the provider window — no reason to scan all of it.
 */
export function hasCreativeLatitude(text) {
  return typeof text === 'string' && text.startsWith(CREATIVE_LATITUDE_HEADING);
}

/**
 * Prepend the clause to a creative prompt. Returns the prompt unchanged when
 * it is empty/non-string or already stamped.
 */
export function withCreativeLatitude(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) return prompt;
  if (hasCreativeLatitude(prompt)) return prompt;
  return `${CREATIVE_LATITUDE_CLAUSE}\n\n---\n\n${prompt}`;
}

// ── Classification ─────────────────────────────────────────────────────────
// Both keys the stamp is driven by — a stage name from data/prompts/stages/ and
// a `runPromptThroughProvider` source tag — are domain-prefixed strings drawn
// from the same vocabulary, so one table classifies both.

/** Prefixes whose stages/runs generate or edit creative work (story, art, canon). */
export const CREATIVE_PREFIXES = Object.freeze([
  'cd-', // Creative Director: treatments, plans, scene evaluation
  'fableloom-',
  'importer-', // extracts canon/arcs out of existing (often licensed) source works
  'media-prompt-', // image/video render-prompt refinement + reverse-engineering
  'music-', // music description, lyrics, music-video scene plans
  'pipeline-', // the whole prose/comic/storyboard/editorial pipeline
  'song-', // Rounds song generation / evaluation / part derivation
  'story-builder-',
  'universe-', // universe builder, vision describe/expand, style reference
  'writers-room-',
]);

/** Creative stages/runs whose names don't carry a domain prefix. */
export const CREATIVE_NAMES = Object.freeze([
  'catalog-extract-ideas-scenes-concepts', // pulls scenes/ideas out of a source work
  'catalog-ideas-scenes-concepts',
  'chiptune-score',
  'game-asset-feedback',
  'manuscript-reformat',
  'meatspace-post-llm', // creative-writing drills (story prompts, what-ifs, reframes)
  'mood-board-style-synthesis',
  'series-review-feedback', // routes the user's free-text notes back into the series
  'threejs-model-generation',
]);

/**
 * Prefixes for operational/analytical STAGES — infrastructure, self-review,
 * model benchmarking, and digital-twin analysis of the operator's OWN writing.
 * None render third-party creative material, so the clause would be noise in
 * their context window. This list has no runtime job beyond making
 * `classifyStage` tri-state: the guard test in `creativeLatitude.test.js` walks
 * every shipped stage and fails on an `unknown`, so a stage nobody thought
 * about can't quietly ship stamped or unstamped.
 */
export const OPERATIONAL_STAGE_PREFIXES = Object.freeze([
  'adversarial-',
  'app-',
  'brain-',
  'cos-',
  'memory-',
  'model-',
  'multi-turn-',
  'soul-',
  'twin-',
  'values-',
]);

/**
 * Run-source tags that are NOT creative — infrastructure, self-analysis, and
 * model benchmarking. Purely a forcing function: `creativeLatitude.sources.test.js`
 * scans every `source:` literal handed to the shared runners and fails on one
 * that appears in neither table, so a new creative service can't ship
 * unstamped just because nobody remembered this file.
 */
export const OPERATIONAL_RUN_SOURCES = Object.freeze([
  'activity-digest',
  'agent-personality-generation',
  'ai-app-detect',
  'cos-persistent-mind',
  'digital-twin',
  'goal-scorecard',
  'jira-title',
  'loop', // user-authored recurring prompts — one tag for every kind, so it can't be split
  'memory-embedding-summary',
  'meatspace-post-rhetoric-evaluator',
  'model-personality-alignment',
  'model-personality-profile',
  'moltbook-challenge',
  'pm2-standardize',
  'record-merge-ai',
  'system-resource-triage',
  'task-enhancement',
  'twin-enrichment-interpret',
]);

const startsWithAny = (name, prefixes) => prefixes.some((p) => name.startsWith(p));

/** True when a stage name or run-source tag names creative work. */
function isCreativeLabel(label) {
  if (typeof label !== 'string' || !label) return false;
  return CREATIVE_NAMES.includes(label) || startsWithAny(label, CREATIVE_PREFIXES);
}

/** 'creative' | 'operational' | 'unknown' — 'unknown' is what the guard test fails on. */
export function classifyStage(stageName) {
  if (typeof stageName !== 'string' || !stageName) return 'unknown';
  if (isCreativeLabel(stageName)) return 'creative';
  if (startsWithAny(stageName, OPERATIONAL_STAGE_PREFIXES)) return 'operational';
  return 'unknown';
}

/**
 * True when a stage's rendered template should carry the clause.
 *
 * Fails SAFE — anything not recognized as operational is treated as creative.
 * Stage prompts are overwhelmingly creative (117 of the 144 shipped ones), and
 * a user can mint a stage at runtime from the Prompt Manager, which no shipped
 * table can enumerate. Getting it wrong toward creative costs a few hundred
 * tokens on an ops prompt; getting it wrong the other way is exactly the
 * watered-down output this module exists to prevent. The tri-state
 * `classifyStage` still forces a decision for every SHIPPED stage via the
 * guard test — this default only governs stages the tables never saw.
 */
export function isCreativeStage(stageName) {
  return classifyStage(stageName) !== 'operational';
}

/**
 * True when a `runPromptThroughProvider` source tag names a creative request.
 *
 * An ALLOWLIST, unlike the stage side: run sources are dominated by
 * operational calls (health checks, classification, PM2 standardization), so
 * the safe default flips. `creativeLatitude.sources.test.js` scans the
 * repo's `source:` literals and fails on one that is in neither table, so an
 * unclassified creative service can't ship silently either.
 */
export function isCreativeRunSource(source) {
  return isCreativeLabel(source);
}

/**
 * The clause's token cost, for callers that budget a context window BEFORE the
 * stamp lands. A stage template is stamped by `buildPrompt` — i.e. before
 * `planManuscriptChunks` measures it — but a hand-rolled prompt is stamped
 * later, inside the runner, so its planner has to reserve this explicitly or it
 * quietly spends someone else's cushion. Computed at module load from the
 * clause itself, so a reworded clause re-measures instead of drifting.
 */
export const CREATIVE_LATITUDE_TOKENS = estimateTokens(`${CREATIVE_LATITUDE_CLAUSE}

---

`);
