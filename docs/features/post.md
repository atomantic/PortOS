# POST (Power On Self Test)

POST is a daily cognitive self-test and training system within MeatSpace. Sessions take ~5 minutes and balance testing with active training — teaching techniques and building skills, not just measuring them.

> The POST overhaul epic (#1985) is actively evolving this area (responsive layouts, analytics, spaced repetition, adaptive difficulty). This doc describes the shipped state; expect churn.

## Cognitive Domains

Six drill domains, each individually enable/disable-able (`client/src/components/meatspace/post/constants.js`):

### Mental Math (~60s)
`doubling-chain` (sequential doubling from a seed), `serial-subtraction` (countdown by a fixed subtrahend), `multiplication` (random N-digit problems), `powers` (base^exponent), `estimation` (approximate large arithmetic within tolerance).

### Memory (~90s)
Memory Builder drills drawn from the user's memory items: `memory-sequence`, `memory-element-flash`, and `memory-fill-blank`, practiced in the standalone Memory Builder (see below). The server's scored-session rescoring accepts `memory-sequence`/`memory-element-flash` (`POST_SUPPORTED_MEMORY_TYPES`), but the session launcher currently composes scored sessions from the math, wordplay/verbal/imagination (LLM), and cognitive domains only — memory training runs separately.

### Wordplay (~60s)
`pun-wordplay` and `word-association`, plus the cacheable wordplay set: `compound-chain`, `bridge-word`, `double-meaning`, `idiom-twist`. All LLM-scored.

### Verbal Agility (~60s)
`wit-comeback` (respond to scenarios with humor), `verbal-fluency` (name category items against the clock), `story-recall` (read a paragraph, answer detail questions). LLM-scored.

### Imagination & Ideation (~60s)
`what-if` (absurd hypotheticals), `alternative-uses` (divergent-thinking classic), `story-prompt` (micro-story from 3 random words), `invention-pitch`, `reframe` (recast a negative situation positively/humorously). LLM-scored for originality, elaboration, and feasibility.

### Cognitive (~90s)
Classic psychometric drills, scored deterministically server-side (`server/services/meatspacePostCognitive.js`, runner `PostCognitiveDrillRunner.jsx`): `n-back`, `digit-span`, `stroop`, `schulte-table`, `mental-rotation`, `reaction-time`.

### Morse (training-only)
`MorseTrainer.jsx` (`morse-copy`, `morse-head-copy`, `morse-send`, deep-linked at `/post/morse/:mode`) is deliberately excluded from scored sessions — Morse practice posts to the training log only.

## Session Structure

A POST session pulls drills from each enabled domain against the per-domain time budgets above (~5.5 minutes total with transitions; `DrillTransition.jsx` handles the interstitials). The session state machine is `client/src/hooks/usePostSession.js`.

## Training vs Testing

The session launcher (`PostSessionLauncher.jsx`) has a per-session Test/Train toggle:

- **Test** — timed, scored, saved to session history (`POST /api/meatspace/post/sessions`).
- **Train** — immediate feedback, hints on wrong answers, not scored; entries go to a separate training log (`POST /api/meatspace/post/training`) with its own stats, streaks, and entries endpoints (`server/services/meatspacePostTraining.js` → `data/meatspace/post-training-log.json`).

## Memory Builder

Configurable memory training for songs, poems, sequences, speeches, or any ordered content (`server/services/meatspacePostMemory.js`; client `MemoryBuilder.jsx`, `MemoryPractice.jsx`).

- **Built-in content**: Tom Lehrer's "The Elements" (code-embedded, id `elements-song`, non-deletable) with per-line element mappings and a specialized `ElementsSong.jsx` UI with periodic-table visualization.
- **Custom items**: users add any text/song/sequence; the system chunks it into progressive recall exercises.
- **Practice modes** (`MemoryPractice.jsx`): `learn` (progressive reveal), `fill-blank`, `sequence` (continue from a starting point), `speed-run`, and `spaced` (spaced-repetition mode focusing the weakest chunks with graduated hints).
- **Spaced repetition**: an SM-2-inspired scheduler tracks per-chunk `ease`/`intervalDays`/`nextReview` (ease clamped 1.3–5, intervals capped at 365 days, misses reset to relearn). `GET /post/memory-items/due` surfaces what's due; per-item and per-chunk mastery are queryable.

## Scoring

- **Math**: server-rescored — the server strips client-provided correctness and re-derives expected answers (`meatspacePost.js`, "never trust client-provided expected"); estimation compares within tolerance. Accuracy plus speed bonus.
- **Cognitive**: deterministic server-side rescoring per drill type.
- **Wordplay/Verbal/Imagination**: LLM-scored against per-drill rubrics (e.g. wit-comeback: humor 40% / cleverness 30% / relevance 30%), blended as quality 80% + speed bonus 20% (`server/services/meatspacePostLlm.js`).
- **Session score**: weighted average across completed drills.

## Adaptive Difficulty

Opt-in adaptive tuning for math drills (`server/lib/postAdaptive.js`): recent scored performance nudges drill parameters, with a transparent preview of what would change (`GET /api/meatspace/post/adaptive-preview`).

## Drill Cache

The four cacheable wordplay types are pre-generated so drills serve instantly (`server/services/meatspacePostDrillCache.js` → `data/meatspace/post-drill-cache.json`, seeded from `data.reference/`). Per the AI-provider policy, a cold cache is never filled silently: boot loads only what's on disk, and the bulk fill runs solely from `POST /api/meatspace/post/drill-cache/fill` behind a consent prompt in `WordplayTrainer.jsx` that names the provider/model. Incremental top-ups after the user has engaged are silent by design.

## Daily Reminder

`server/services/meatspacePostReminder.js` schedules an optional daily POST reminder, re-registered whenever the config changes.

## Data Files

- `data/meatspace/post-config.json` — drill settings, enabled domains, time limits
- `data/meatspace/post-sessions.json` — scored test session history
- `data/meatspace/post-memory-items.json` — memory builder content and mastery
- `data/meatspace/post-training-log.json` — unscored training/practice log
- `data/meatspace/post-drill-cache.json` — pre-generated wordplay drills

## Routes

All under `/api/meatspace` (`server/routes/meatspacePostRoutes.js`):

- `GET/PUT /post/config` — drill configuration
- `GET/POST /post/sessions`, `GET /post/sessions/:id` — scored session history
- `GET /post/stats` — rolling averages
- `POST /post/drill` — generate a drill (dispatches math / LLM / memory / cognitive)
- `GET /post/adaptive-preview` — adaptive-difficulty preview
- `POST /post/score-llm` — score LLM drill responses
- `GET /post/drill-cache/status`, `POST /post/drill-cache/fill` — wordplay cache
- `POST /post/training`, `GET /post/training/{stats,entries}` — training log
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
