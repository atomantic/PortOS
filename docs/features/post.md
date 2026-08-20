# POST (Power On Self Test)

POST is a daily cognitive self-test and training system within MeatSpace. Sessions take ~5 minutes and balance testing with active training — teaching techniques and building skills, not just measuring them.

> The POST overhaul epic (#1985) is actively evolving this area (responsive layouts, analytics, spaced repetition, adaptive difficulty). This doc describes the shipped state; expect churn.

## Cognitive Domains

Six drill domains, each individually enable/disable-able (`client/src/components/meatspace/post/constants.js`):

### Mental Math (~60s)
`doubling-chain` (sequential doubling from a seed), `serial-subtraction` (countdown by a fixed subtrahend), `multiplication` (random N-digit problems), `powers` (base^exponent), `estimation` (approximate large arithmetic within tolerance).

### Memory (~90s)
Memory Builder drills drawn from the user's memory items: `memory-sequence`, `memory-element-flash`, and `memory-fill-blank`, practiced in the standalone Memory Builder (see below). The server's scored-session rescoring accepts all three types (`POST_SUPPORTED_MEMORY_TYPES`, issue #2099), but the session launcher currently composes scored sessions from the math, wordplay/verbal/imagination (LLM), and cognitive domains only — memory training runs separately (`memory-fill-blank` isn't yet one of the types `DOMAINS.memory.drillTypes` offers to pick from).

### Wordplay (~60s)
`pun-wordplay` and `word-association`, plus the cacheable wordplay set: `compound-chain`, `bridge-word`, `double-meaning`, `idiom-twist`. All LLM-scored.

### Verbal Agility (~60s)
`wit-comeback` (respond to scenarios with humor), `verbal-fluency` (name category items against the clock), `story-recall` (read a paragraph, answer detail questions). LLM-scored.

### Imagination & Ideation (~60s)
`what-if` (absurd hypotheticals), `alternative-uses` (divergent-thinking classic), `story-prompt` (micro-story from 3 random words), `invention-pitch`, `reframe` (recast a negative situation positively/humorously). LLM-scored for originality, elaboration, and feasibility.

### Cognitive (~90s)
Focused cognitive-skill drills, scored deterministically server-side (`server/services/meatspacePostCognitive.js`, runner `PostCognitiveDrillRunner.jsx`): `n-back`, `digit-span`, `stroop`, `schulte-table`, `mental-rotation`, `reaction-time`, `task-switching`, `go-no-go`, and `flanker`.

The executive-control pack practices three narrow task skills; it is not a clinical assessment and makes no claim of generalized cognitive transfer:

- **Task Switching** applies a visible color/shape/fill rule, measuring switch cost and repeat-vs-switch accuracy. Its ladder changes rule count, switch rate, cue lead, conflicting attributes, and response deadline.
- **Go / No-Go** responds to go signals and withholds to no-go lures, measuring hits, omissions, false alarms/commission errors, correct rejections, and latency. Its ladder changes no-go frequency, stimulus duration, lure similarity, and deadline.
- **Flanker Control** reports a center arrow around agreeing or conflicting flankers, measuring congruency cost, congruent/incongruent accuracy, omissions, and latency. Its ladder changes congruency ratio, flanker distance/strength, and deadline.

Each generated executive-control drill carries a seed. The server regenerates its answer key from that seed and the validated difficulty config when saving either a scored session or an atomic training run; client-provided correctness and aggregate metrics are never authoritative.

### Morse (training-only)
`MorseTrainer.jsx` (`morse-copy`, `morse-head-copy`, `morse-send`, deep-linked at `/post/morse/:mode`) is deliberately excluded from scored sessions — Morse practice posts to the training log only.

## Session Structure

The launcher offers two ways to start (`DrillTransition.jsx` handles the between-drill interstitials; the session state machine is `client/src/hooks/usePostSession.js`):

- **Full session** — queues every enabled math/LLM/cognitive drill; math and LLM drills carry their configured time limits, while cognitive drills are self-paced/stimulus-driven with no countdown.
- **Quick session** — pulls one random drill per enabled domain against the per-domain time budgets above (~5.5 minutes total with transitions).

## Training vs Testing

The session launcher (`PostSessionLauncher.jsx`) has a per-session Test/Train toggle:

- **Test** — timed, scored, saved to session history (`POST /api/meatspace/post/sessions`).
- **Train** — immediate feedback and hints on wrong answers. The client saves the completed run once through `POST /api/meatspace/post/training/runs`; the server validates the full batch and commits the run plus every attempt in one PostgreSQL transaction. Stable run/attempt ids make retries idempotent. The results screen reports success only after that durable acknowledgement and leaves a failed save retryable. `POST /api/meatspace/post/training` remains as the backward-compatible one-entry adapter for standalone trainers and older clients.

## Memory Builder

Configurable memory training for songs, poems, sequences, speeches, or any ordered content (`server/services/meatspacePostMemory.js`; client `MemoryBuilder.jsx`, `MemoryPractice.jsx`).

- **Built-in content**: Tom Lehrer's "The Elements" (code-embedded, id `elements-song`, non-deletable) with per-line element mappings and a specialized `ElementsSong.jsx` UI with periodic-table visualization.
- **Custom items**: users add any text/song/sequence; the system chunks it into progressive recall exercises.
- **Practice modes** (`MemoryPractice.jsx`): `learn` (progressive reveal), `fill-blank`, `sequence` (continue from a starting point), `speed-run`, and `spaced` (spaced-repetition mode focusing the weakest chunks with graduated hints).
- **Spaced repetition**: an SM-2-inspired scheduler tracks per-chunk `ease`/`intervalDays`/`nextReview` (ease clamped 1.3–5, intervals capped at 365 days, misses reset to relearn). `GET /post/memory-items/due` surfaces what's due; per-item and per-chunk mastery are queryable.

## Scoring

- **Math**: server-rescored — the server strips client-provided correctness and re-derives expected answers (`meatspacePost.js`, "never trust client-provided expected"); estimation compares within tolerance. Accuracy plus speed bonus.
- **Cognitive**: deterministic server-side rescoring per drill type. Executive-control attempts additionally retain switch/congruency cost, false alarms, omissions, commission errors, accuracy/completion, and the per-response latency distribution in the unified run/attempt record.
- **Wordplay/Verbal/Imagination**: LLM-scored against per-drill rubrics (e.g. wit-comeback: humor 40% / cleverness 30% / relevance 30%), blended as quality 80% + speed bonus 20% (`server/services/meatspacePostLlm.js`).
- **Session score**: per-module weighted mean across completed drills (`computeSessionScore`, weights from `config.scoring.weights`, issue #2099). Every module defaults to weight `1.0`, so an unconfigured install still gets the plain arithmetic mean; a module absent from a saved `weights` map also defaults to `1.0` rather than dropping out.

## Benchmark vs. Training (issue #4442)

An ordinary **Test** session (above) scores whatever drills the user's current, possibly adaptive, configuration happens to select — useful for daily practice, but not a stable measurement, since two Test sessions can differ in composition, difficulty rung, or drill order and still get compared as if they were the same instrument. A **Benchmark** run is a separate, fixed-form assessment:

- Composition, drill order, difficulty, and timing come entirely from a registered protocol (`POST_BENCHMARK_PROTOCOL`, `server/services/meatspacePost.js`), never from the user's adaptive/training configuration — no progressive ladder, no random Quick composition, no due maintenance reps, no hints or training feedback.
- Every run stores `protocolId`, `protocolVersion`, `scorerVersion`, and `formId` on its durable session record (`postBenchmarkSchema`, `server/lib/postValidation.js`), and the server rejects a submission whose tasks/config don't match the form it claims (`assertBenchmarkSession`) — a benchmark result can't be silently produced by a mismatched or hand-edited config.
- The protocol offers a small set of alternate **forms** (`GET /api/meatspace/post/benchmark/protocol`), rotated without immediate repetition so back-to-back runs don't reuse the same generated shapes; each form's tasks are deterministic/seeded, so a stored run is reproducible from its identity alone.
- **Trend comparisons stay protocol-scoped.** `getPostProgress`'s `series.benchmark` includes only sessions whose `protocolId`/`protocolVersion`/`scorerVersion` match the *currently registered* protocol; a run under a retired protocol/scorer version, or an ordinary Test/Train/Quick session, is excluded from that series (never silently blended in) and counted in `excludedCount` so the Progress UI can say why a session doesn't appear. The general `series.byDay` "Score Trend" is unchanged and still blends every scored session — it answers "how active/well am I doing generally," not "is this benchmark-comparable."
- This is a training aid, not a clinical, diagnostic, IQ, or generalized-cognitive-transfer instrument — no such claim is made or implied by a benchmark score.

Session **conditions** (optional, set at launch — `PostSessionLauncher.jsx`) are structured rather than free text: `sleepQuality` (poor/fair/good), `caffeine` (none/low/moderate/high), `stress` (low/moderate/high), plus an optional free-text note (`postConditionsSchema`). This makes conditions filterable/comparable across sessions instead of the prior unconstrained strings; historical sessions recorded before this change keep whatever free-text `tags` they were saved with as legacy metadata, which the server still accepts but the launcher no longer writes.

## Adaptive Difficulty

Opt-in adaptive tuning for math drills (`server/lib/postAdaptive.js`): recent test and training attempts both inform skill evidence and nudge drill parameters, with a transparent preview of what would change (`GET /api/meatspace/post/adaptive-preview`). Training also feeds domain/drill progress, recommendations, progressive-ladder mastery, and mastered-skill retention scheduling. Benchmark/test history remains isolated: training never increments scored-session counts or changes the benchmark headline/overall score. Multiplication is a special case: whenever the progressive ladder is on (the default), it owns multiplication's difficulty entirely and the preview reflects the ladder rung, not the generic `maxDigits` knob — the two are mutually exclusive per drill type, never blended.

## Drill Cache

The four cacheable wordplay types are pre-generated so drills serve instantly (`server/services/meatspacePostDrillCache.js` → `data/meatspace/post-drill-cache.json`, seeded from `data.reference/`). Per the AI-provider policy, a cold cache is never filled silently: boot loads only what's on disk, and the bulk fill runs solely from `POST /api/meatspace/post/drill-cache/fill` behind a consent prompt in `WordplayTrainer.jsx` that names the provider/model. Incremental top-ups after the user has engaged are silent by design.

## Daily Reminder

`server/services/meatspacePostReminder.js` schedules an optional daily POST reminder, re-registered whenever the config changes.

## Storage

- `data/meatspace/post-config.json` — drill settings, enabled domains, time limits
- PostgreSQL `post_runs` + `post_attempts` — normalized test/benchmark/training history (machine-local; never federated)
- `data/meatspace/post-memory-items.json` — memory builder content and mastery
- `data/meatspace/post-drill-cache.json` — pre-generated wordplay drills

On upgrade, `migratePostRunsToDB.js` imports the former `post-sessions.json` and `post-training-log.json` idempotently, preserves authored dates/timestamps, marks unknown legacy fields explicitly, and parks each source as `.imported`. The JSON implementation remains only for `NODE_ENV=test` / `MEMORY_BACKEND=file` development coverage.

## Routes

All under `/api/meatspace` (`server/routes/meatspacePostRoutes.js`):

- `GET/PUT /post/config` — drill configuration
- `GET/POST /post/sessions`, `GET /post/sessions/:id` — scored session history
- `GET /post/stats` — rolling averages
- `GET /post/benchmark/protocol` — the next fixed-form benchmark battery and its versioned scoring contract
- `GET /post/progress` — time-series trends, including the protocol-scoped `series.benchmark`
- `POST /post/drill` — generate a drill (dispatches math / LLM / memory / cognitive)
- `GET /post/adaptive-preview` — adaptive-difficulty preview
- `POST /post/score-llm` — score LLM drill responses
- `GET /post/drill-cache/status`, `POST /post/drill-cache/fill` — wordplay cache
- `POST /post/training/runs` — atomic, idempotent completed training-run save
- `POST /post/training`, `GET /post/training/{stats,entries}` — one-entry compatibility adapter and training reads
- `GET/POST /post/memory-items`, `GET/PUT/DELETE /post/memory-items/:id` — memory item CRUD
- `GET /post/memory-items/due` — spaced-repetition due list
- `POST /post/memory-items/:id/practice` — submit practice result, update mastery
- `GET /post/memory-items/:id/{mastery,chunk-mastery}` — mastery breakdowns
- `POST /post/memory-drill` — generate memory drills

## UI Components

Container: `client/src/components/meatspace/tabs/PostTab.jsx` (view router: launcher, running, results, history, config). In `client/src/components/meatspace/post/`:

- `PostSessionLauncher` — start screen with Test/Train toggle and drill summary
- `PostDrillRunner` — math drills; `PostLlmDrillRunner` — all LLM drills (wordplay/verbal/imagination); `PostCognitiveDrillRunner` — cognitive drills
- `PostSessionResults`, `PostHistory` (date-range analytics), `PostDrillConfig`
- `MemoryBuilder`, `MemoryPractice`, `ElementsSong`
- `WordplayTrainer` (standalone wordplay practice + cache-fill consent), `WordplayDrillUI`, `MorseTrainer`, `DrillTransition`
