# server/lib/editorial — editorial check registry

The backbone of the extensible editorial-review system (#1284, epic #1283): a
declarative registry of "editorial checks" that plug into the series pipeline.
Each check declares its scope, kind, default severity, a Zod config schema, an
optional gate, and a `run(ctx)` that returns findings shaped for the existing
`manuscriptReview` comment store. The runner that builds the shared `ctx`, runs
the enabled checks, and seeds findings lives at
`server/services/pipeline/editorial/checkRunner.js`.

`scope` is a `series | issue | scene | noun` granularity. A check meaningful at
more than one granularity may declare an **array** — `scope: ['series', 'issue']`
(#1628) — instead of being split into two near-duplicate checks; the string form
keeps working. `normalizeCheckScopes` / `primaryCheckScope` (in `checkRegistry.js`)
normalize either form, the load-time guard validates every member, and
`resolveCheckState` exposes both a single primary `scope` (for single-value
consumers) and the full `scopes` array (the catalog and dry-run plan fan a
dual-scope check across each of its declared scopes).

This directory is **pure** (no side-effecting imports — only `zod` and the pure
`estimateTokens` budgeter). LLM-kind checks get their model caller through
`ctx.callStagedLLM` (or `ctx.callInlineLLM` for user-defined checks), and a
manuscript-consuming LLM check plans the corpus into provider-sized chunks
through `ctx.planManuscriptChunks` — all injected by the runner. Per-chunk
findings are merged first-wins (capped at the check's `maxFindings`) via
`editorialFindingKey`, so a long series is fully reviewed regardless of the
provider's context window (#1340).

Checks whose problems span chapters can opt into a **cross-chunk continuity
digest** (#1383): pass `crossChunkDigest: true` to `runManuscriptLlmCheck` and
each chunk after the first is prefixed with `editorialPriorFindingsDigest` of the
findings gathered so far (it rides INSIDE the manuscript var, so no prompt
template change). The digest body is capped (`EDITORIAL_PRIOR_DIGEST_CHARS`) and
**yields to manuscript coverage**: the runner's chunker reports each chunk's
`usableChars` budget, and the digest is prepended only when it fits the chunk's
spare room — so it never displaces manuscript text or overflows the provider
window (a chunk packed to the budget just runs without a digest).
`style.conformance` (tense/POV established earlier),
`objects.unmotivated-interaction` (setup/payoff across chapters), and
`roster.unmodeled-names` (so a later part doesn't re-describe an unmodeled name an
earlier part already surfaced) opt in; `prose.info-dumping` stays per-chunk (its
problems are localized).

A check that re-sends a context block per chunk (the reverse-outline scene map,
character arcs, plotline coverage, style-guide expectations, …) declares it as a
`context: { varName: string }` map on `runManuscriptLlmCheck` rather than baking it
into `overheadTokens`. The runner counts the block as overhead AND, on a small or
fallback context window where a large reverse outline would consume the whole
usable budget and slice the manuscript chunk to `''` (#1459), trims the block to
guarantee the manuscript a budget floor (`MANUSCRIPT_FLOOR_TOKENS`) — the LARGEST
block trimmed first, so the unbounded scene map absorbs the cut while bounded
blocks survive. `buildVars(manuscript, meta, context)` receives the trimmed blocks
as its third arg, so the check feeds the SAME context it was budgeted for. A
plain whole-manuscript scan with no re-sent context keeps the simpler
`overheadTokens` form.

`roster.unmodeled-names` also shows the LLM/deterministic split that keeps a
chunked judgment correct: the model does ONLY what it alone can — surface a proper
noun used as a character name and confirm it's a person (not a place/org/brand/
honorific). A deterministic post-pass in `run()` then counts each surfaced name's
distinct-issue appearances across the WHOLE `ctx.sections` corpus and **authors the
final `location` / `problem` / `suggestion` / severity itself** from that count
(keeping only the model's `anchorQuote` + `issueNumber`). It does NOT append to the
model's free text — owning the frequency narrative outright means a stray model
claim ("appears only once") can't contradict the deterministic verdict. Recurrence
is a whole-corpus count the model can't make per-chunk (a name in issues 1 and 12
looks like a one-off to whichever chunk sees it), so it never trusts the model for
it; a surfaced name the matcher can't find in any section is dropped, not reported.

The findings digest carries prior *problems* forward but not clean prior *setup*
— a payoff in a later chunk can be mis-flagged "missing setup" when the earlier
chunk established it without producing a finding. A check can additionally opt
into a **cross-chunk clean-setup digest** (#1403): pass `crossChunkSetup: true`
(plus a per-check `setupFocus` string) to `runManuscriptLlmCheck`, and after each
non-final chunk one extra inline summarization call (`ctx.callStageScopedInlineLLM`,
tagged `EDITORIAL_SETUP_DIGEST_SOURCE`, built by `buildSetupDigestPrompt`) rolls a
short "setup so far" summary forward. The summary call is **stage-scoped** — it
resolves the same provider/model the check's stage is pinned to (not the active
provider), so manuscript text never routes to a different (e.g. cloud) provider
than the stage chose. The stored summary is capped to `EDITORIAL_SETUP_DIGEST_BODY_CHARS`
so a verbose summarizer response can't compound across chunks. `editorialSetupDigest` wraps it and prepends it to
later chunks alongside the findings digest — also yielding to spare budget, and
fitted *after* the findings digest so manuscript coverage and the findings digest
both win when budget is tight. A single-chunk (whole-fits) run never summarizes,
so it pays nothing. When the reverse-outline (#1349) or continuity-bible (#1305)
artifacts land, either could feed this context more cheaply than a per-chunk call.

## Inter-check context sharing (#1627)

Within a single pass a check can read the findings produced by **other checks it
explicitly depends on**, so compound signals are possible (e.g. on-the-nose
dialogue that is *also* doing exposition for a setup another check flagged). The
sharing is **opt-in and scoped**, which keeps every other check a pure function of
its declared `sources` (order-independent):

- A check declares `dependsOn: ['<otherCheckId>', …]` on its registry entry. The
  runner topologically orders the pass (`orderChecksByDependencies`) so every
  declared dependency runs **before** the dependent — independent checks keep their
  exact registry order, so a pass where nothing opts in is unchanged.
- During its `run(ctx)`, the dependent reads `ctx.priorFindings` — the stamped
  findings (each carrying `checkId`) that its declared dependencies produced earlier
  this pass — or `ctx.findingsByCheck('<id>')` for a single dependency's findings.
  Both are **scoped to declared deps only**: a check that declares no `dependsOn`
  always sees an empty `ctx.priorFindings`, and `findingsByCheck` returns `[]` for
  any id the check didn't declare. The array and each finding are **frozen** — a
  check may read but never mutate another check's already-seeded findings.
- Degrade-tolerant: a dependency that is disabled, outside a targeted subset run, or
  errored this pass simply contributes no findings (the dependent still runs). A
  dependency **cycle** is a registry bug — it's logged and the cycle's members fall
  back to registry order. The dependent must therefore tolerate missing prior
  findings. `dependsOn` shape (string-array, no self-reference) is enforced at load.
- **Staleness is dependency-aware.** Because a dependency-consuming finding can
  change when its *dependency's* source content drifts (not only its own), the
  staleness fingerprint and the per-source I/O gates fold in each check's transitive
  declared-dependency sources (`effectiveCheckSources` in the runner). So a compound
  finding goes stale exactly when any source it transitively depended on changes —
  never falsely fresh, never falsely stale — computed identically at seed-time and
  read-time. A check with no `dependsOn` is fingerprinted on its own `sources` as
  before.

## Discovery rule

Before adding an editorial rule, check whether an existing registry entry covers
it. To add a new built-in check, append an entry to `EDITORIAL_CHECKS` in
`checkRegistry.js` (the fail-fast guards enforce shape, enum, and unique-id).

Declare every input the check's `run(ctx)` reads in its `sources` array (a
non-empty subset of `EDITORIAL_SOURCES`: `manuscript`, `canon`,
`series.styleGuide`, `series.arc.tickingClock`, `series.arc.readerMap`,
`series.arc.themes`, `reverseOutline`, `reverseOutline.plotlines`,
`editorialArcs`, `series.characterArcs`, `storyboard.shots`, `comicScript`,
`prose`).
The `series.arc.themes` token (#1317) fingerprints the AUTHORED arc themes the
`theme.coherence` check reconciles the prose against (lives on the already-loaded
series record, no extra I/O — adding/editing a declared theme stales its findings).
The staleness
runner fingerprints exactly those sources, so a finding goes stale only when
content the check actually analyzed drifts — declare too few and a finding stays
falsely fresh; a `manuscript` source must pair with `needsManuscript: true`, and
`reverseOutline` makes the runner fetch the cached reverse-outline (#1286) and
inject `ctx.reverseOutline` (the scenes array); `reverseOutline.plotlines` (#1310)
injects `ctx.reverseOutlinePlotlines` (the outline's plotline list) off that same
fetch, so the `plot.structure-momentum` check can reconcile dropped subplots
against the author's tagged threads. `editorialArcs` (#1295) makes the
runner fetch the series editorial aggregate and inject `ctx.editorialArcs` (the
detected per-character `{ name, arcDirection, issueCount, isProtagonist }`
projection — the coarse DETECTED arc signal) plus a derived
`ctx.editorialArcsComplete` boolean (true only when every analyzable issue is
analyzed and fresh), so a check can tell "absent because arc-less" from "absent
because not-yet-analyzed" under a partial coverage batch. `series.characterArcs`
(#1293) reads the AUTHORED per-character arcs off the already-loaded series
record (`series.characterArcs[]` — want/need, start → end state, transition
beats), which the `arc.transitions` check reconciles detected change moments
against. `storyboard.shots` (#1315) is built off the already-loaded issues (no
extra I/O) and injects `ctx.storyboardScenes` (a flat `{ issueNumber, scene }`
list for every issue with storyboard scenes), which the deterministic
`visual.shot-continuity` check reads for 180°-rule axis reversals + shot-type
monotony and the LLM siblings `visual.eyeline-match` (#1466) and
`visual.appearance-continuity` (#1467) read for gaze reciprocity and
appearance/prop continuity respectively. `comicScript` (#1313) fingerprints every issue's AUTHORITATIVE comic content,
keyed by issue number — the edited comic-pages split (`stages.comicPages.pages[]`)
when present, else the generated `stages.comicScript.output` (derived from the
already-loaded `ctx.issues`, no extra fetch). The `comic.lettering-density` check
reads the same content (via the shared `comicLetteringIssues`) to count
balloon/panel/page word load, so a finding stales exactly when the comic text the
check read changes — not when an unrelated image renders. The LLM check
`comic.prose-sync` (#1589) is the CROSS-MEDIA sibling: for a hybrid comic+prose
issue it pairs that issue's **`prose`-stage** text with its comic content
(`comicScript.pacing`) and flags substantive divergences — an unshown beat,
contradicted dialogue, or a chronology disagreement — making one model call per
hybrid issue and fingerprinting both the prose and the comic so a finding stales
when either drifts. It declares the `prose` source (not `manuscript`) on purpose:
the stitched manuscript picks `comicScript` over `prose` for a hybrid issue, so a
`manuscript` source would compare the comic against itself; both halves are read off
the already-loaded `ctx.issues` (the `prose` stage via `proseStageIssues`). When a new check reads a
`ctx.series` field (or another artifact) that isn't yet a token, add the token to
`EDITORIAL_SOURCES` and a matching resolver in the runner's `SOURCE_RESOLVERS`.

## User-defined checks (#1346)

Users author their own LLM checks (name + prompt + scope) from the Editorial
Checks UI — no code change. A custom check's DEFINITION lives in settings
(`pipelineEditorialChecks.customChecks[]`); its enable/config override reuses the
SAME `checks[id]` slice the built-ins use. `buildCustomCheck(def)` synthesizes a
definition into the exact shape the registry/runner consume (an always-
manuscript-consuming LLM check, `id` prefixed `custom.`), so it flows through
`resolveCheckState` / `getEnabledChecks` / the runner identically to a built-in.
The fixed findings-JSON output contract is enforced by `buildCustomCheckPrompt`
(the user only describes WHAT to look for), and the model is called through the
runner-injected `ctx.callInlineLLM` (an inline-prompt sibling of
`ctx.callStagedLLM`, no shipped stage template). CRUD lives at
`POST/PATCH/DELETE /api/pipeline/editorial/custom-checks`.

| Module | Purpose |
|---|---|
| `checkRegistry.js` | The public entry point. Assembles `EDITORIAL_CHECKS` by spreading the per-category arrays from `./checks/*.js`, re-exports the shared infra from `./checkInfra.js`, and keeps the registry's lookup/state helpers that need the assembled array: `EDITORIAL_SOURCES` (the per-check `sources` vocabulary the staleness runner fingerprints, #1387), fail-fast guards (`assertValidChecks`), and `getCheck`, `getCheckById`, `getAllChecks`, `listChecks`, `resolveCheckState`, `getEnabledChecks`, `resolveCheckConfig`, `orderChecksByDependencies` (the dependency topo-sort, #1627) plus the user-defined-check helpers (`buildCustomCheck`, `readCustomCheckDefs`, `isCustomCheckId`, `isValidCustomCheckDef`). Decomposed from a 7,474-line god file in #1829. |
| `checkInfra.js` | Shared check infrastructure extracted in #1829: imports + constants + stage names + the pure summary/helper functions (e.g. `runManuscriptLlmCheck`, `canonCharacterTraitsSummary`, `editorialFindingKey`, `buildCustomCheckPrompt`, `normalizeCheckScopes`/`primaryCheckScope`) that the check definitions and the registry tail depend on. Kept side-effect-free so `./checks/*.js` import from it without a cycle through `checkRegistry.js` (whose `EDITORIAL_CHECKS` spread would otherwise hit a TDZ on the checks' eagerly-evaluated `configSchema`s). Re-exports its externals (zod + the sibling primitive modules) so a check file imports everything from one hub. |
| `checks/*.js` | The `EDITORIAL_CHECKS` definitions, grouped by category (#1829): `naming`, `cast`, `pov`, `characterArc`, `continuity` (incl. #2178 `continuity.premature-reveal` — the information-economy guard that flags a reveal-gated canon fact leaked before its reveal issue, reconciled against `revealGatedCanonSummary`; gated on `canonHasRevealGated`), `comic`, `visual`, `scene`, `dialogue`, `proseStyle`, `research`, `slop` (#2165 — `prose.slop-banned-words`/`prose.ai-tells`/`prose.structural-tics`/`prose.burstiness`, built on `../slopScore.js`), `world` (#2175 — `world.unforeshadowed-solution`/`world.cost-free-power`, the review-side companion to the Sanderson's-Laws worldbuilding doctrine injected into the universe-expansion generation prompt; reconciles against canon + the continuity-bible world-rule facts). Each exports a `<group>Checks` array of declarative check entries (scope, kind, severity, `configSchema`, `gate`, `run(ctx)`); `checkRegistry.js` imports and spreads them. Internal to the registry — imported only via `checkRegistry.js`, not the barrel. |
| `nameSimilarity.js` | Pure, dependency-free name-confusability primitives for `naming.dissimilar-names` (#1291): `normalizeName`, `vowelSkeleton`, `soundex` (phonetic key), `levenshtein` (edit distance), `nameSimilaritySignals` (the per-pair signal list, with option toggles), and `firstLetterHistogram` / `findFirstLetterClusters` (cast first-letter crowding). |
| `cliches.js` | Pure, dependency-free cliché + overwriting primitives for `prose.cliches` and `prose.modifier-stacking` (#1308): `CLICHE_PHRASES` (seed stock-simile/idiom list), `findCliches` (whole-word phrase scan with house-style allow/extra lists), and `findModifierStacking` (cumulative no-comma runs of 3+ stacked adjectives/adverbs). The LLM sibling `prose.dead-metaphor` handles the judgment cases (mixed/dead metaphor, novel clichés, purple prose). |
| `italicThoughts.js` | Pure, dependency-free italic-thought primitive for `prose.italic-thoughts` (#1300): `findItalicThoughts` (multi-word markdown `*…*` / `_…_` italic runs, dedup + word-count threshold so single-word emphasis, bold, and `snake_case` are skipped). The LLM siblings (`opening.wrong-start`, `prose.mirror-description`, `dialogue.pleasantries`, `prose.kill-your-darlings`) handle the judgment cases in the #1300 anti-pattern bundle. |
| `proseTics.js` | Pure, dependency-free copy-edit prose-tic primitives for the #1306 line-edit group: `tokenizeWords` / `splitSentences` (shared tokenization), `findFilterWords` (`prose.filter-words`), `findHedgeWords` (`prose.hedge-words` — hedge/weasel distance markers: metaphorical distance, dialogue hedges, cognitive weasel words), `findCrutchWords` (`prose.crutch-words`), `findAdverbs` (`prose.adverbs` — `-ly` adverbs + dialogue-tag adverbs), `findPassiveVoice` (`prose.passive-voice` — be-verb + past-participle heuristic; classifies each hit `weak`/`stative`/`mood` + `byAgent` so #1593 context tuning can suppress intentional passive) and its `filterPassiveVoice` companion (drops `stative` predicate-adjectives + `mood` setting images unless `suppressIntentional` is off), `findGestures` (`prose.repeated-gestures` — gesture tally + body-part autonomy), plus the seed `FILTER_WORDS` / `HEDGE_WORDS` / `CRUTCH_WORDS` / `GESTURE_WORDS` lists. The LLM sibling `prose.telling-emotion` handles the named-emotion judgment case. |
| `repetition.js` | Pure, dependency-free word-echo & rhythm primitives for #1306: `findWordEchoes` (`prose.word-echoes` — distinctive word repeated within a window), `findRepeatedOpeners` (runs of sentences sharing an opener, "He… He… He…"), and `measureSentenceRhythm` (`prose.sentence-rhythm` — sentence-length variation). Reuses `tokenizeWords` / `splitSentences` from `proseTics.js`. |
| `slopScore.js` | Pure, dependency-free deterministic "AI slop" scoring primitives for #2165 (CWQE Phase 1) — EXTENDS proseTics.js/cliches.js/repetition.js rather than duplicating them: tiered banned-word scanners (`findBannedWordsTier1` hard-ban, `findSuspiciousWordClusters` Tier 2 cluster-of-3+) backing `prose.slop-banned-words`; fiction AI-tell idiom regexes (`findAiTells`) backing `prose.ai-tells`; rhetorical structural-tic detectors (`findNotJustButPatterns`, `findNotSayingPatterns`, `findNegativeAssertions`, `findTheWaySimiles`, `findTriadicShortSentences`, combined by `findStructuralTics`) backing `prose.structural-tics`; and quantitative burstiness signals (`emDashDensityPer1000`, `transitionOpenerRatio`, `paragraphLengthUniformity`, `countSectionBreaks`) backing `prose.burstiness`. `computeSlopPenalty()` composites all of the above — plus `repetition.js`'s sentence-length CV, read but never re-reported as its own finding — into a documented-weight 0–10 penalty for Phase 3's `qualityScore = judgeOverall − slopPenalty`. |
| `voiceFingerprint.js` | Pure, dependency-free statistical voice-fingerprint primitives for the deterministic `style.voice-drift` check (#2166 — CWQE Phase 2), the cheap sibling of the LLM `style.voice-consistency`. Reuses `tokenizeWords`/`splitSentences` (proseTics.js) + `splitParagraphs`/`emDashDensityPer1000` (slopScore.js) rather than re-implementing them. `computeFingerprint(text)` measures one issue's metric vector (sentence mean/σ/CV, fragment %, long-sentence %, paragraph mean/σ, dialogue ratio, em-dash rate, abstract-noun & simile density per 1k, dominant sentence-opener %, plus optional `well:*` vocabulary coverage); `splitManuscriptByIssue` / `voiceFingerprintMatrix` fingerprint every `# Issue N` section; `computeVoiceDrift` computes series mean/σ per metric and flags issues > threshold·σ out (small-N gated below `minIssues`); `parseVoiceWells` parses the `name: word, word; …` config spec; `describeDrift` renders a finding sentence; `renderFingerprintTable` renders the issues×metrics matrix (outliers marked); `describeMetricColumn(key)` / `metricUnit(key)` give the self-describing column header (label/unit/higher/lower/isWell) shared by the finding text and the deep-linkable matrix view (#2194). `VOICE_METRICS` is the static metric descriptor list. |
| `comicPacing.js` | Pure, dependency-free comic-pacing primitives for the #1314 comic-pacing group: `isSplashPage`, `comicSpreadLayout` (recto/verso + spread + `beginsSpread` page-turn map), `summarizeComicPages`, `analyzePanelRhythm` (`comic.panel-rhythm` — splash overuse / back-to-back splashes / overcrowded pages / grid monotony), `comicPageTurnSummary` + `authoredRevealSummary` (LLM-context renderers for `comic.page-turn-beats`). Operates on already-parsed comic pages (the runner parses each issue's stored comic script and injects them as the `comicScript` source) so the editorial dir stays import-pure. |
| `shotContinuity.js` | Pure, dependency-free storyboard shot-continuity primitives for the deterministic `visual.shot-continuity` check (#1315): `findAxisReversals` (180°-rule axis flips across a continuity-linked shot pair using `screenDirection`) and `findShotTypeMonotony` (a scene whose classified shots all share one `shotType`). Also `summarizeStoryboardShots` (#1466) — renders the collected `{ issueNumber, scene }` storyboard list into a compact per-scene shot block shared by the LLM siblings `visual.eyeline-match` (gaze reciprocity / eyeline-vs-screen-direction) and `visual.appearance-continuity` (#1467 — diffs the same entity's wardrobe/prop/setting descriptions across shots for contradictions). Reads the shot-grammar fields from `server/lib/shotGrammar.js`. |
| `dialogue.js` | Pure, dependency-free dialogue-tag primitives for the #1307 dialogue-craft group: `findSaidBookisms` (`dialogue.said-bookisms` — ornate speech tags like *expostulated*/*opined* and non-speech tags like "she smiled", matched only when adjacent to a double-quote span) and `findUnattributedDialogueRuns` (`dialogue.attribution-clarity` — runs of consecutive untagged/unbeated dialogue lines where the speaker can't be tracked), plus `attributeDialogueByOwner` (the coarse per-character dialogue-line tally behind `cast.representation-balance`'s dialogue-share signal, #1312 — credits each quoted paragraph to the first owner named in its beat) and the seed `SAID_BOOKISMS` / `NON_SPEECH_TAGS` lists. Also `inventoryDialogueTags` + `splitScenes` + `findDialogueTagVariety` (`dialogue.tag-variety`, #1587 — per-scene tag inventory flagging within-scene **monotony** (one verb dominates) and **over-variation** (a fresh verb on nearly every line); collapses inflections onto a base lemma via `PLAIN_SPEECH_TAG_GROUPS`). The LLM siblings `dialogue.on-the-nose` (subtext-free / "as you know, Bob" dialogue) and `dialogue.voice-distinctiveness` (per-character voice against canon `speechPattern`/`speechAccent`) handle the judgment cases. |
| `letteringDensity.js` | Pure, dependency-free comic lettering-density primitives for `comic.lettering-density` (#1313): `countWords`, `panelLetteringMetrics` (per-panel balloon/caption/SFX word + balloon tally over the `comicScriptParser` output), `analyzeComicLettering` (flags balloons/panels/pages over the configurable thresholds in `DEFAULT_LETTERING_THRESHOLDS`), `overflowSeverity` (severity scaled by how far over the limit), and `sanitizeLetteringThresholds`. Mirrored to `client/src/lib/letteringDensity.js` for the comic-script stage's inline warnings — keep the two in sync. |
| `balloonAttribution.js` | Pure, dependency-free comic speech-balloon attribution primitives for `comic.balloon-attribution`: `analyzeBalloonAttribution` (flags a dialogue line whose speaker isn't shown in the panel description and carries no off-panel/broadcast cue — the case the image model mis-attributes to a visible character), `splitSpeaker`, `nameInText`, and `OFFPANEL_OK_MODIFIER` (the broadcast/off-panel/V.O./transmission modifier vocabulary — mirrors `visualStages.js` `BALLOON_STYLE_HINTS`, keep in sync). Severity scales `medium`/`low` by whether another canon character is visibly named in the panel. |
| `panelDisagreement.js` | Pure reader-panel disagreement-mining primitives for the four-persona reader panel (#2170 — CWQE Phase 6): the `PANEL_PERSONAS` / `PANEL_QUESTIONS` vocabulary, `sanitizePersonaResponse` (one persona's raw LLM answer → stable `{ persona, answers:{<qid>:{text,issues[]}}, verdict }` shape), `minePanelDisagreements` (cross-persona `consensus` ≥3-persona concern citations / `attention` some-but-not-all / `polarizing` best-vs-worst-scene splits), and `consensusToFindings` (consensus entries → `seedReviewFromFindings` finding shapes). Pure — all I/O (digest build, per-persona LLM calls, snapshot storage, review seeding) lives in `server/services/pipeline/readerPanel.js`. |
| `severityConfig.js` | Pure per-series severity-config helpers (#1616): the frozen `DEFAULT_SEVERITY_WEIGHTS` (high:12/medium:5/low:1) + `DEFAULT_BLOCKING_SEVERITIES` per autopilot gate (`BLOCKING_GATES` = arc/beatContinuity/editorial), `mergeSeverityWeights` (merge a per-series weight override over the defaults — absent/invalid keys keep the default), `resolveBlockingSet` (the per-gate blocking `Set` — `Array.isArray` first so an explicit empty `[]` "nothing blocks" is distinct from an absent gate's default), and the wire bounders `sanitizeSeverityWeights` / `sanitizeBlockingSeverities` (persisted on the series record, gated at `pipelineSeries` v9). Reuses `CHECK_SEVERITIES` from `checkRegistry.js` as the canonical enum so the wire gate can't drift. |
| `index.js` | Barrel re-export of the above. |
