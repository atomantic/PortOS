# Creative Writing Quality Engine — porting autonovel's adversarial methods

**Date:** 2026-07-04
**Status:** Approved design record; work tracked as GitHub issues (epic + phases)
**Source review:** `~/github.com/autonovel` — a standalone Python pipeline that autonomously wrote, revised, and typeset a complete 75k-word fantasy novel (*The Second Son of the House of Bells*) using a modify→evaluate→keep/discard loop.

## Why

PortOS already has a deep creative-writing stack: Universe/Story Builder, Writers Room, the Series Pipeline with a 68-check editorial registry, deterministic health scoring (`editorialScore.js`), the Manuscript Editor with anchored fix generation, and a full Series Autopilot (`seriesAutopilot.js`). What it lacks — and what autonovel proved out in production — is the **adversarial quality loop**: a separate judge model that scores drafts against a calibrated rubric, mechanical anti-slop metrics that penalize that score, cut-based editing where "what an editor would cut IS the revision plan," comparative ranking instead of absolute scores, and a revision loop that iterates to quality convergence instead of pausing after a fixed round count.

### Gap analysis (PortOS today vs autonovel)

| Capability | PortOS today | autonovel | Gap |
|---|---|---|---|
| Draft evaluation | 68 editorial checks → severity findings → deterministic health score | Calibrated LLM judge (9 dims, "median AI chapter = 6") minus a mechanical slop penalty | No LLM quality *score*; no anti-inflation calibration; no writer/judge model split |
| Anti-slop | `proseTics.js`, `cliches.js`, `repetition.js` (filter/hedge/crutch words, adverbs, passive, stock similes) | Adds quantitative signals: sentence-length CV (burstiness), em-dash density, transition-opener ratio, tiered banned-word clusters, fiction AI-tell regexes, structural tics | Missing the quantitative/statistical layer and the fiction-specific AI-tell corpus |
| Editing | Anchored find/replace fixes from findings; manual accept | Adversarial "cut N words" pass with 6-type classification + mechanical `apply_cuts` (exact match → whitespace-normalized fallback) | No cut-based diagnostic; no safe-type batch application |
| Ranking | Absolute severity-weighted score only | Head-to-head forced-pick + Swiss Elo tournament ("1-10 scoring collapses to a 2-point band") | No comparative eval; weakest-chapter detection is score-based only |
| Reader feedback | Reader-emotion curves (`editorialAnalysis.js`) | 4-persona reader panel; *disagreements* between personas drive revision priorities | No persona simulation, no disagreement mining |
| Voice consistency | `style.voice-consistency` (LLM, subjective tone) | Statistical voice fingerprint: per-chapter metrics vs novel mean, >1.5σ outlier flagging | No cheap deterministic drift detection |
| Autonomous revision | Autopilot pauses after `MAX_EDITORIAL_ROUNDS = 2`; craft findings advisory, never auto-applied | 3–6 revision cycles with per-chapter keep/revert score gate, plateau detection (Δ < 0.3), hedge-aware stopping ("costs of ambition" language → converged) | No iterate-to-quality loop; no keep/revert gate; no qualification-aware stop |
| Writers Room | Single-shot evaluate/format/script passes | (n/a — whole pipeline is the loop) | No multi-pass autonomous polish for freeform prose |
| Craft knowledge in prompts | Style guide + per-stage templates | 24 hard anti-pattern rules in every draft prompt; "Stability Trap" countermeasures; foreshadowing ledger with plant→payoff distance ≥ 3 chapters | Draft prompts don't encode the learned anti-pattern corpus |

### Design principles ported from autonovel

1. **Writer/judge model split.** The model that evaluates must differ from the model that writes ("intentionally different to avoid self-congratulation").
2. **Dual immune system.** A free, deterministic regex/statistics slop scorer runs beside the LLM judge; its penalty is subtracted from the judge's score (`quality = judgeScore − slopPenalty`). The mechanical layer catches what the judge normalizes away.
3. **Cuts are diagnosis.** Asking an editor persona to cut ~10% and *classify* each cut (FAT / REDUNDANT / OVER-EXPLAIN / GENERIC / TELL / STRUCTURAL) yields both an actionable edit list and a fat-percentage health metric. In autonovel production, OVER-EXPLAIN + REDUNDANT were ~55-60% of all cuts and safe to auto-apply.
4. **Comparative beats absolute.** Forced-pick head-to-head with Elo produces discrimination that rubric scores can't ("not allowed to call it a tie").
5. **Disagreement is signal.** Multi-persona reader panels are mined for chapters that *some but not all* personas flag — that's where editorial decisions live.
6. **Keep/revert gates + plateau + qualification-aware stopping.** A revision is kept only if the post-score ≥ pre-score (else revert the snapshot). Stop cycling when score delta plateaus or when review language shifts from defects to hedged trade-offs ("individually fine," "costs of ambition").
7. **Calibration ladders fight inflation.** Judge prompts state explicitly: "the median competent AI-generated chapter is a 6; a 10 does not exist for a draft," and force quote-level evidence (3 strongest / 3 weakest sentences).

## Phases

Each phase is an independent GitHub issue; ordering below is the dependency graph. All LLM-calling features respect the AI Provider Usage Policy: passes run from direct user actions or from the already-consented Series Autopilot (cos autonomy domain + daily budget), never from boot.

### Phase 1 — Deterministic slop score + burstiness metrics

New pure module `server/lib/editorial/slopScore.js` (unit-tested, barrel + README per module rules) that **extends** — does not duplicate — `proseTics.js`/`cliches.js`/`repetition.js`:

- Tiered banned-word lists: Tier 1 hard-ban (delve, tapestry, myriad, plethora, …) penalized per hit; Tier 2 suspicious (robust, seamless, pivotal, …) penalized only in clusters of ≥ 3 per paragraph.
- Fiction AI-tell regexes: "a sense of X", "couldn't help but", "eyes widened", "let out a breath (s)he didn't know", "a wave of X washed over", "heart pounded in", emotion-adverb telling.
- Structural tics: "not just X, but Y", "I'm not saying X, I'm saying Y", negative-assertion repetition ("did not [verb]" density), "the way X did Y" simile counter, triadic short-sentence lists.
- Quantitative signals: em-dash density per 1k words (threshold ~15), sentence-length coefficient of variation (CV < 0.3 ⇒ synthetic uniformity), transition-opener ratio (> 0.3), section-break count, paragraph-length uniformity.
- Composite `computeSlopPenalty(text) → 0–10` exported for Phase 3.
- Register issue-scope deterministic checks (`prose.slop-banned-words`, `prose.ai-tells`, `prose.structural-tics`, `prose.burstiness`) in `checkRegistry.js` with anchor-quote findings feeding the existing manuscriptReview/health-score path. Dedupe against existing checks (`prose.sentence-rhythm` is LLM; the CV metric is its deterministic sibling).

### Phase 2 — Statistical voice fingerprint (drift detection)

New pure module `server/lib/editorial/voiceFingerprint.js`: per-issue metrics (sentence mean/std/CV, fragment %, long-sentence %, paragraph-length stats, dialogue ratio, em-dash rate, abstract-noun density, simile density, dominant sentence-opener %, optional vocabulary "wells" configured from the series style guide). Series-scope deterministic check `style.voice-drift`: compute the series mean/σ per metric, flag issues > 1.5σ out with a finding naming the metric and direction. This is the cheap statistical complement to the existing LLM `style.voice-consistency` (`checks/proseStyle.js:945`) — it *verifies* that asserted style rules are statistically true per issue, and names the issue that drifted.

### Phase 3 — Calibrated LLM judge + writer/judge model split *(blocked by Phase 1)*

- Judge role resolution: per-stage judge provider/model in `stage-config.json`, resolved via a `resolveJudgeForStage()` sibling of `resolveProviderForStage()` in `server/lib/stageRunner.js`; defaults to the stage's writer provider but the UI encourages configuring a different model.
- New stage prompt `pipeline-judge-issue.md` (seeded via `data.reference/prompts/stages/`; new file ⇒ `setup-data` copies it, no hash migration): 9 dimensions (voice adherence, beat coverage, character voice, plants seeded, prose quality, continuity, canon compliance, lore integration, engagement), a calibration ladder ("median competent AI-generated chapter = 6; 10 does not exist for a draft; err lower"), a QUOTE TEST (3 strongest / 3 weakest sentences), scene-vs-summary ratio, JSON output.
- Composite score: `qualityScore = judgeOverall − computeSlopPenalty(text)`; persisted per issue+stage in run history and the editorial snapshot; surfaced on the issue page and Editorial Roadmap.
- Optional: pass sampling params (low temperature for judging) where the provider path supports it; CLI providers ignore gracefully.

### Phase 4 — Adversarial cut pass + mechanical cut application

- New issue-scope LLM check `prose.adversarial-cuts`: "ruthless literary editor" persona asked to cut a configurable ~8–12% of the text as 10–20 passages, each an **exact quote ≥ 10 words** classified FAT / REDUNDANT / OVER-EXPLAIN / GENERIC / TELL / STRUCTURAL, plus `fat_percentage`, `tightest_passage` (protected), `one_sentence_verdict`. Findings land as manuscriptReview comments (the anchored-quote shape already fits `findingKey`).
- Mechanical applier (new `server/services/pipeline/applyCuts.js` or extension of `manuscriptFix.js`): exact string match once → whitespace-normalized regex fallback → refuse ambiguous (> 1 occurrence) and short (< 25 char) quotes; filter by cut type (default: OVER-EXPLAIN + REDUNDANT only); per-issue min-fat threshold; dry-run preview; applied through the serialized stage-write path with runHistory snapshot + undo.
- Manuscript Editor UI: "Apply safe cuts" batch action with type filter and impact-preview diff (reuses the existing cumulative-diff preview).

### Phase 5 — Multi-candidate drafting + comparative Elo ranking *(blocked by Phase 3)*

- **Draft gate** (opt-in per stage, default off — it multiplies cost): `draftAttempts: 1–3` in stage config. Generate → judge → if `qualityScore` below threshold, regenerate; keep the best-scoring attempt; rejected attempts persist in run history for inspection.
- **Head-to-head ranking**: new `server/services/pipeline/editorial/comparativeRank.js` — forced-pick compare prompt ("you are not allowed to call it a tie; quote the deciding passage"), Swiss-style tournament (~4 rounds, K=32 Elo) across the series' issues → ranking stored in the editorial snapshot. Weakest-N issues feed revision priorities. Rationale: absolute rubric scores collapse to a 2-point band; comparison forces discrimination.

### Phase 6 — Reader panel personas + disagreement mining

- Condensed arc summary builder (per-issue: 3-sentence summary + opening/closing excerpts + top dialogue lines) reusing `reverseOutline.js` scene segmentation / `arcPlanner/manuscriptDerive.js` so the panel reads a digest, not 75k words.
- Four persona prompts run as separate series-scope LLM calls: **The Editor** (prose texture, subtext, over-explaining), **The Genre Reader** (pacing, "gets bored by beautiful prose that doesn't GO anywhere"), **The Writer** (structure, beats, "worst insult: I can see the outline"), **The First Reader** (pure emotional response, no craft vocabulary). Each answers ~10 qualitative questions (momentum_loss, earned_ending, cut_candidate, missing_scene, thinnest_character, best/worst scene, would_recommend, haunts_you).
- Disagreement mining: extract issue numbers cited per question per persona; issues flagged by *some but not all* personas are surfaced as the editorial attention list; ≥ 3-persona consensus items become manuscriptReview findings / revision priorities.
- Editorial page UI: panel tab showing the four responses side-by-side + the disagreement list.

### Phase 7 — Iterate-to-quality revision loop in Series Autopilot *(blocked by Phases 1, 3, 4; Phases 5–6 enhance it)*

Upgrade the autopilot's editorial convergence (currently `MAX_EDITORIAL_ROUNDS = 2` → pause) to an optional quality-convergence loop:

1. Run adversarial cuts; auto-apply safe types (OVER-EXPLAIN/REDUNDANT).
2. Judge-score every issue (Phase 3); pick the weakest (Elo ranking when Phase 5 is available).
3. Build a revision brief — PROBLEM / **WHAT TO KEEP** (tightest passage, strongest sentences — prevents the rewrite from destroying good material) / WHAT TO CHANGE / VOICE RULES / TARGET length — combining judge output, cut lists, and panel consensus.
4. Apply via anchored manuscript fixes or full-stage regeneration.
5. **Keep/revert gate**: re-judge; keep only if `qualityScore` did not regress, else restore the runHistory snapshot.
6. Stop on: plateau (|Δ series score| < 0.3 after min cycles), max cycles (configurable, cost-conscious default 1–3), or **qualification-aware convergence** — classify remaining findings as actionable vs hedged ("individually fine," "deliberate choice," "costs of ambition"); majority-hedged ⇒ converged.

All steps stay gated on the cos autonomy domain + daily action budget exactly as today; the divergence/oscillation pause is retained.

### Phase 8 — Craft-knowledge prompt upgrades (anti-pattern rules + Stability Trap)

- New shared prompt partial (via `server/lib/promptPartials.js`) `craft-anti-patterns`, injected into `pipeline-prose.md` and `writers-room-continue.md`: no triadic sensory lists; "He did not [verb]" ≤ 1/chapter; no "thought about X" constructions; "the way X did Y" ≤ 2/chapter; no over-explaining after showing; section breaks ≤ 2; vary paragraph length; end chapters differently; ≥ 70% in-scene; dialogue sounds like speech; include one surprising moment.
- Stability Trap countermeasures block (from the Rettberg & Wigers finding that AI stories favour stability over change): characters must end truly different; let bad things stay bad; allow irreversible loss; withhold information; choices need real cost.
- Foreshadowing ledger: extend the arc prompts to emit plant → reinforce → payoff entries with plant-to-payoff distance ≥ 3 issues; `chekhov.setups-payoffs` consumes the ledger.
- **Migration required:** editing existing shipped stage templates needs a `scripts/migrations/NNN-*.js` entry keyed on the old shipped hash + the drift-warning mirror in `scripts/setup-data.js` (both `OLD_SHIPPED_MD5` and `NEW_SHIPPED_MD5`), with line-ending normalization — per the stage-prompt migration rule in CLAUDE.md.

### Phase 9 — Writers Room autonomous polish loop *(blocked by Phase 4)*

- New pass kinds in `writersRoom/evaluator.js` `KIND_META`: `cuts` (adversarial cut pass over the work body) and `revise` (brief-driven rewrite that receives the old draft as raw material + a WHAT TO KEEP section).
- Multi-pass "Polish" runner: evaluate → cuts → apply safe cuts → revise → re-evaluate → keep/revert gate against body snapshots (add body history under `data/writers-room/works/<id>/` if absent), with cycle count and live SSE progress. Triggered by an explicit user action (satisfies the AI policy), cycles configurable.

### Future (parked)

- **Scheduled autopilot runs** — cron-scheduled Series Autopilot via the task scheduler; sanctioned under the AI policy as a user-configured scheduled automation, but needs an explicit setup UI naming provider/model + budget cap.
- Audiobook generation from finished manuscripts (autonovel's ElevenLabs speaker-attribution pipeline) — separate epic if wanted.
- Graduated per-stage sampling parameters as a first-class stage-config feature (blocked on provider-path support for sampling params).

## Explicitly not ported

- autonovel's git-commit/`reset --hard` keep/discard substrate — PortOS already has runHistory snapshots + serialized stage writes; reuse those.
- Its bespoke brace-matching JSON parser — PortOS has structured-output handling in the toolkit; only borrow ideas if fence-stripping gaps surface.
- `results.tsv` experiment ledger — the editorial snapshot + revision-trend ledger (`editorialScore.js`) already covers this.
