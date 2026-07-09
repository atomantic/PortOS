# Human Activity Tracking — Life Timeline → Digital Twin / Tribe / Autobiography

**Date:** 2026-07-04
**Status:** Approved design (brainstormed + approved in session; tracked as GitHub issues)
**Epic:** see the `area:life-tracking` epic issue

## Vision

Track the human across communications and interactions — email, calendar, iMessage,
Signal, YouTube watch history, Spotify listening history — to:

- enhance the **digital twin** (taste, chronotype, behavioral patterns from real data
  instead of questionnaires)
- strengthen **tribe** connections/reminders (richer touchpoint signal from more channels)
- generate **daily-log auto-drafts** feeding the autobiography/life record
- evaluate **effectiveness at achieving goals** (time allocation vs stated goals)
- (later) create **proactive communication prompts** with real conversational context

## Core architectural decisions

1. **Unified activity store, machine-local.** New Postgres table
   `human_activity_events` that all ingestion sources write into. Machine-local like
   Tribe (per ADR `docs/decisions/2026-06-26-tribe-and-universe-runs-local.md`) —
   events are coupled to per-machine accounts, OS databases (chat.db), and the local
   browser profile. Excluded from peer sync, guarded in `sharing/peerSync.test.js`
   the same way tribe is.
2. **Derived outputs federate** via existing rails:
   - daily-log drafts → Brain `journals` entity (already federates, LWW delta log)
   - taste/chronotype enrichment → `data/digital-twin/*` (already federates via
     `digital-twin-sync.js`)
   - goal scorecards → `insightsService` artifacts
   Each machine ingests what it can see; summaries converge everywhere.
3. **Privacy stance: metadata + short summary only.** Full message bodies stay in the
   existing per-source caches (`data/messages/cache/`, chat.db itself, etc.). Events
   carry pointers (`account_id`, `metadata.externalId`) back to the source. Nothing
   leaves the machine except federated derived summaries the user opted into.
4. **Idempotent ingestion.** Every event carries a stable `dedupe_key`; unique index on
   `(source, dedupe_key)`; `ON CONFLICT DO NOTHING` — re-syncs are no-ops. Same
   contract as `tribe_touchpoints.dedupe_key`. Timezone-correct local-day keys via
   `server/lib/timezone.js`.
5. **Deterministic identity matching, no LLM in the ingestion path.** Reuse
   `server/lib/tribeMatch.js` + `tribe_people.emails[]`; add `phones[]` for
   iMessage/Signal handle matching.
6. **AI-provider policy compliance.** No cold-bootstrap LLM calls. All LLM-backed
   consumers (daily-log drafts, goal narrative) are explicit opt-in scheduled
   automations with a config UI naming the provider/model. Ingestion and aggregation
   are LLM-free.

## Schema

```sql
CREATE TABLE IF NOT EXISTS human_activity_events (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,          -- gmail|outlook|teams|calendar|imessage|signal|spotify|youtube
  account_id TEXT,               -- per-source account ref (machine-local)
  kind TEXT NOT NULL,            -- message.sent|message.received|calendar.event|media.listen|media.watch
  happened_at TIMESTAMPTZ NOT NULL,
  duration_s INTEGER,            -- listens/watches/meetings
  title TEXT,                    -- subject / track / video / event title
  summary TEXT,                  -- short human-readable line, NOT full body
  url TEXT,
  participants JSONB DEFAULT '[]'::jsonb,  -- [{ name, email, phone, personId? }]
  metadata JSONB DEFAULT '{}'::jsonb,      -- source-specific (threadId, artist, channel, ...)
  dedupe_key TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_human_activity_dedupe
  ON human_activity_events (source, dedupe_key);
CREATE INDEX IF NOT EXISTS idx_human_activity_happened
  ON human_activity_events (happened_at);
```

DDL lives in `server/lib/db.js` beside the tribe tables; migration in
`scripts/migrations/`.

## Phases (one GitHub issue each)

### Phase 1 — Foundation: activity store + timeline service + existing-source hooks
- `server/services/humanActivity.js`: `recordEvents(candidates)` (idempotent),
  query APIs (`listEvents({ from, to, source, kind, personId })`, day summaries,
  hourly histograms).
- Secondary `.catch()`-guarded hooks in `messageSync.js` and `calendarSync.js`
  (mirroring `logMessageTouchpoints`) so Gmail/Outlook/Teams/calendar populate the
  timeline immediately.
- `/timeline` page: deep-linkable day view (`/timeline/:date?`), `NAV_COMMANDS` entry,
  route + Zod validation, mobile responsive.
- Peer-sync exclusion guard test.

### Phase 2 — iMessage ingestion (macOS chat.db)
- Read-only SQLite read of `~/Library/Messages/chat.db` via Node ≥22 built-in
  `node:sqlite` (zero new deps, per dependency policy).
- Apple epoch (Mac absolute time, ns since 2001-01-01) conversion; `attributedBody`
  typedstream fallback when `text` is NULL (best-effort extraction; skip cleanly on
  parse failure).
- Add `phones[]` to `tribe_people` (+ migration + GIN index) and extend
  `tribeMatch.js` to match phone handles.
- Feeds `tribe.autoLogTouchpoints()` + activity store. Incremental cursor on
  `message.ROWID`.
- Scheduled via `eventScheduler`; settings UI with enable toggle; setup check
  endpoint surfacing the Full Disk Access requirement (attempt open, report
  actionable error).

### Phase 3 — Spotify listening history
- User-created Spotify dev app (client id/secret in settings); OAuth
  authorization-code flow, tokens in `data/` (mirroring `googleAuth.js` layout).
- Poll `GET /v1/me/player/recently-played` (50-track window) every ~25 min via
  `eventScheduler` → `media.listen` events (`dedupe_key = played_at + track id`).
- Track/artist/genre metadata into `metadata` for later twin enrichment.

### Phase 4 — YouTube watch history
- No API exists. CDP scrape of `youtube.com/feed/history` via the managed browser
  profile (`browserService.js`), mirroring `messagePlaywrightSync.js` patterns;
  auth-redirect detection for signed-out state.
- Google Takeout `watch-history.json` importer for backfill (file upload → parse →
  `recordEvents`).
- `media.watch` events; scrape cadence conservative (a few times/day).

### Phase 5 — Signal Desktop ingestion
- Decrypt Signal Desktop's SQLCipher DB. Key retrieval: `config.json` legacy plaintext
  key OR (Signal ≥6.2) `encryptedKey` wrapped by macOS Keychain via Electron
  safeStorage — needs keychain read of the Signal Safe Storage entry.
- Highest fragility (breaks on Signal schema/crypto changes); wrap in a
  version-check + graceful-degradation report rather than hard failure.
- Phone-number handle matching (reuses Phase 2 `phones[]`), feeds tribe touchpoints +
  activity store.

### Phase 6 — Daily-log auto-drafts (federated output #1)
- Evening scheduled job (dedicated scheduler patterned on `brainScheduler.js`,
  catch-up on missed days) — **explicit opt-in config UI naming provider/model**
  per AI policy; silent until enabled.
- Summarizes the day's timeline into a clearly-marked auto-generated section
  appended to that day's Brain journal entry (via `brainJournal` upsert → federates,
  vector-embeds via `brainMemoryBridge`). Dictated/typed content stays primary;
  the draft never overwrites user text.

### Phase 7 — Twin enrichment: taste + chronotype (federated output #2)
- LLM-free aggregates: `media.listen`/`media.watch` rollups (artists, genres,
  channels, topics) → taste-profile evidence records in `data/digital-twin/`;
  hourly activity histogram (messages sent, media consumed by hour) → chronotype
  evidence.
- LLM-assisted interpretation (e.g. "what does this say about me") only on explicit
  user action from the Digital Twin UI.

### Phase 8 — Goal effectiveness scorecard (federated output #3)
- Weekly correlation of time allocation (from timeline) against
  `data/digital-twin/goals.json`; scorecard artifact via `insightsService` →
  Insights page. Optional LLM narrative behind the same opt-in automation config
  as Phase 6.

## Deferred (labeled `future`)
- **Proactive communication prompts** — extend `proactiveAlerts.js` +
  `messageDrafts.js`: timeline-aware outreach drafts for overdue tribe people
  ("you never replied to X's message about Y"). Deferred until timeline density
  proves out.
- **Autobiography era synthesis** — synthesize accumulated timeline months into
  autobiography story drafts (`autobiography.js`).
- **Full-history Takeout backfill** — Gmail full-history, YouTube full-history,
  Google location history importers.
- **Additional sources** — WhatsApp, Discord, browser history.
- **Cross-domain correlation** — calendar↔health/sleep timing (the density gap
  called out in issue #738 / `2026-06-03-cross-domain-insights-engine.md`).

## Testing
- `humanActivity.db.test.js` gated to `portos_test` (never the real DB, per the
  db-guards contract).
- Pure-logic tests beside each source module (epoch conversion, dedupe keys,
  typedstream fallback, Takeout parsing) with fixture files.
- Peer-sync exclusion asserted in `sharing/peerSync.test.js` style guard.
