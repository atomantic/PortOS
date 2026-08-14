# ADR: Strict JSON Reads Wherever a File-Backed Value Is Counted, Displayed, or Written Back

- **Date:** 2026-08-14
- **Status:** Accepted
- **Related:** issue #4115 (this audit), issue #2726 (introduced
  `readJSONFileStrict`, scoped to the Character sheet's file-backed signals),
  [`server/lib/fileUtils.js`](../../server/lib/fileUtils.js),
  [`server/lib/README.md`](../../server/lib/README.md), root `CLAUDE.md`
  ("Sentinel + validate to distinguish 'not set / failed' from
  'present-but-empty / valid'").

## Context

`readJSONFile(path, default)` and `tryReadFile(path)` both collapse three
distinct states into one value:

| State | `readJSONFile` | `tryReadFile` |
| --- | --- | --- |
| Absent (ENOENT — never written) | `default` | `null` |
| Present but unreadable (EACCES, EIO, EISDIR, …) | `default` | `null` |
| Present but corrupt / truncated JSON | `default` | *(n/a — no parse)* |

For a config-ish read with a sensible fallback that collapse is correct and is
the long-standing behavior of ~230 call sites. It is **wrong** in two situations,
and #2726 only fixed the first for one feature:

1. **The value is counted or displayed.** A swallowed unreadable file reports a
   confident `0` — "0 notifications", "0% aligned", "0/5 dispatches used" — which
   the user reads as fact rather than as "we could not read your data".
2. **The value is the base of a read-modify-write.** This is the more damaging
   half and was not in the original framing. `load → mutate → save` over a
   swallowed default writes the *empty default* back over the real file. The read
   does not merely misreport the data; it destroys it on the next write.

`tryReadFile` additionally had no strict counterpart at all, so two callers had
hand-rolled their own — `settings.js#readSettingsStrict` re-probed with
`access()` after the fact (a second syscall that can disagree with the read it is
explaining), and `layeredIntelligence/sources.js#gatherPlannedWork` gated on
`existsSync` before reading.

## Decision

1. **Add `tryReadFileStrict(path, encoding?)` → `{ ok, value }`** to
   `server/lib/fileUtils.js`, the raw-bytes twin of `readJSONFileStrict`. ENOENT
   — the only errno that *proves* absence — yields `{ ok: true, value: null }`;
   every other read failure yields `{ ok: false, value: null }`. It shares the
   Windows `atomicWrite` swap-window retries with `readJSONFileStrict`, so a
   write in flight cannot masquerade as ENOENT.

2. **Convert a `readJSONFile` call site to a strict read when *either* is true:**
   its result feeds a count / a displayed stat / a gate threshold, **or** it is
   the base of a write back to the same file. Leave it swallowing when the value
   is a config fallback, a single-record lookup, or a derived cache that is
   regenerated rather than merged.

3. **Pick the failure shape from the caller's position, not mechanically:**
   - *Request-path reader* → `readJSONFile(…, { strict: true })`, which throws and
     bubbles to the error middleware. Prefer this where the function can already
     reject (e.g. it awaits `ensureDir` first), so no caller contract changes.
   - *Ledger/gate with a "skip this cycle" posture* → `readJSONFileStrict` and
     return an explicit `null`, letting the write path refuse to overwrite. This
     is the `quotaBurnCompletions.js` / `quotaBurnDenials.js` shape.
   - *Status/display path reading the same file as a gate* → may degrade to the
     empty default, because the cost of being wrong there is a stale label rather
     than a destroyed ledger or re-spent quota. Say so at the call site.

4. **Never re-swallow downstream.** A `.catch(() => [])` on a strict reader
   cancels the whole fix; two such catches were removed in `videoDownload.js`.

## Audit (#4115)

`server/` holds ~237 non-test `readJSONFile` call sites and ~130 `tryReadFile`
call sites. They were triaged by tracing each reader's wrapper function to its
consumers (routes, widgets, schedulers) and to any write back to the same path.

### Converted

| Call site | Why |
| --- | --- |
| `services/usage.js#loadUsage` | The `!usageData` branch overwrites `usage.json` with zeros on the same tick — an unreadable file erased all historical usage/cost/rollups permanently. |
| `services/apps.js#loadApps` | The reader itself writes: an empty `apps` map makes the baseline branch rewrite `apps.json` with a lone PortOS entry, deleting every registered app. Also feeds `getAppStatusSummary`'s total/online/unmanaged. |
| `services/instances.js#loadData` | Every mutation runs through `withData`, which saves whatever was read. A swallowed read hands `ensureSelf` an identity-less record — it mints a new `instanceId` and wipes every peer. |
| `services/quotaBurn.js#getQuotaBurnDispatches` | `dispatchesUsed` is both the `maxDispatchesPerWindow` gate and the family card's `N/M used`. Now returns `null` on a failed read (matching its two sibling ledgers); the cycle skips and the write refuses. The status path degrades to `{}` deliberately. |
| `services/notifications.js#loadNotifications` | `getUnreadCount` is the bell badge (`GET /api/notifications/count`); also the base of every `saveNotifications`. |
| `services/review.js#loadItems` | `getPendingCounts` reduces it into the Review Hub tiles; also the base of every `saveItems`. |
| `services/memoryStore.js#loadIndex`, `#loadEmbeddings` | `index.count` and `Object.keys(vectors).length` *are* the Memory stats card, both values are cached for the process lifetime, and both are written back. |
| `services/decisionLog.js#loadDecisions` | `getDecisionSummary` divides by `recentDecisions.length` for the transparency score; `stats.totalDecisions` is a lifetime counter that `saveDecisions` writes back. |
| `services/domainUsage.js#readFreshLedger` | The fall-through resets the day's ledger to zeros and `recordDomainUsage` writes it back — zeroing the Domain Budgets panel *and* re-opening a domain that had spent its cap. |
| `services/videoGen/history.js#loadHistory` | Every write goes `loadHistory → mutate → saveHistory`; a swallowed read persists `[]` over the whole render history. |
| `services/dataSync.js#getVideoHistorySnapshot` | Would publish a valid checksum over an empty set, so peers conclude this machine holds no videos and the category thrashes forever. |
| `services/dataSync.js#applyVideoHistoryRemote` | The merge base — an empty `local` makes the merged result the remote rows alone, deleting every local-only row. |
| `services/videoDownload.js` (×2) | Removed `.catch(() => [])` wrappers that re-swallowed `loadHistory`'s new strict signal. |
| `services/settings.js#readSettingsStrict` | Routed onto `tryReadFileStrict`, replacing a hand-rolled `access()` re-probe. Same three-state verdict, one syscall, no window in which the probe can disagree with the read. |
| `services/taskLearning/store.js#loadLearningData` | Every routing outcome, duration sample and failure signature is recorded by `load → mutate → saveLearningData`; the next save wrote a fresh `DEFAULT_LEARNING_DATA` over the entire learning history. The 5s cache also re-served the fabricated default. |
| `services/taskLearning/store.js#loadDismissedRecommendations` | `dismissRecommendation` / `restoreRecommendation` change one key and write the whole map back — an unreadable file silently un-dismissed every recommendation on the next dismissal. |
| `services/goalScorecard.js#getSettings` | The base of `updateSettings` (`get → merge → write`), so a corrupt file wrote `DEFAULT_SETTINGS` over the user's provider, model and week-start on the next PATCH. |
| `services/goalScorecard.js#getRuleOverrides` | Hand-authored overrides that are never regenerated. An empty read presented an empty rules editor whose next save persisted the emptiness. |
| `services/goalScorecard.js#loadGoals` | Goals are what every event is scored *against*. Zero rules means every hour buckets as unaligned, and `computeWeeklyScorecard` persists — and splices into the Brain daily log — a confident "0% goal-aligned". |
| `services/goalScorecard.js#getScorecard`, `#refreshScorecardNarrative` | Both reported `not_computed` — the UI's "click Compute" state — for an artifact that exists but could not be read. The narrative path is additionally the base of a write back to the same artifact. |
| `services/goalCheckIn.js#runGoalCheckIn` | Reported `{ checked: 0 }` off a fake empty `goals.json`, indistinguishable from a user with no active goals; the run also writes the whole file back. |
| `services/brainStorage.js#loadMeta` | `updateMeta` is `load → spread → saveMeta`, so a corrupt `meta.json` wrote the shipped defaults over every brain setting — and the result was cached for `CACHE_TTL_MS`, outliving the read that produced it. |
| `services/appActivity.js#loadAppActivity` | Every writer is `load → mutate → save`; a swallowed read wrote `DEFAULT_ACTIVITY` over every app's cooldown, agent binding and lifetime review stats, *and* dropped the whole fleet off cooldown so the CoS immediately re-reviewed all of it. The shallow `{ ...DEFAULT_ACTIVITY }` spread was replaced with a `structuredClone` in the same pass — the default's `apps`/`global` were shared objects that the first write against an absent file mutated in place. |
| `services/telegram.js#loadCheckins` | `handleCheckinResponse` is `load → push → atomicWrite`, so answering one check-in against a fake empty log wrote a one-entry file over the whole history. Uses a **null sentinel rather than a throw**: every caller runs inside a `bot.on(...)` handler that node-telegram-bot-api never awaits, so a rejection would leak as an unhandled rejection instead of reaching a caller. Callers bail and tell the user nothing was overwritten. A readable-but-shapeless file (no `checkins` array) gets the same `null` — we can't interpret it, so we must not replace it either. |
| `services/mediaJobQueue/index.js#initMediaJobQueue` | Init ends with `await persist()`, which writes the FULL in-memory snapshot — so an unreadable `media-jobs.json` booted an empty queue and immediately wrote `{"jobs":[]}` over the real one, losing the archive and orphaning every job the reconcile would have reattached. Cannot throw: init is an awaited step of `runPostRouteSequence`, where a rejection is fatal (`process.exit`). Instead it boots empty, reports, and **latches persistence off** for the process so the file survives for recovery. |

### Reviewed and deliberately left swallowing

- **Config / settings reads with a real default** — `openclaw/api.js`,
  `dashboardLayouts.js`, `autobiography.js#loadConfig`, `browserService.js`,
  `meatspaceAlcohol.js` config, `datadog.js`, `updateChecker.js#pkg`. A fallback
  is the documented behavior; nothing is counted and nothing is written back over
  the file.
- **Single-record lookups** — `tools.js`, `dailyReview.js`, `jiraReports.js`,
  `askConversations.js`, `bibleStore.js`, `goalCalendarScheduler.js`, the
  `sprites/*` manifest/sidecar readers, `sharing/importer.js`'s per-record reads.
  A miss surfaces as a 404 rather than a fabricated total.
- **Sidecars and derived caches** — `assetHash.js`, `mediaSketches.js`,
  `insightsService.js` theme/narrative caches, `calendarSync.js`. Regenerated on
  a miss, never merged into.
- **Federation cursors and bucket indexes** — `sharing/manifest.js`,
  `sharing/subscriptions.js`, `sharing/buckets.js`, `sharing/exporter.js`,
  `peerTombstoneCursors.js`. Add-only merges whose worst case on a failed read is
  re-processing an already-seen item, not deleting one.
- **One-shot migration scripts** — `server/scripts/migrate*ToDB.js`,
  `pipeline/migrateSeriesCanon.js`. They read a legacy path that is *expected* to
  be absent and are re-runnable.
- **`layeredIntelligence/sources.js#gatherPlannedWork`** — already distinguishes
  the three states via an `existsSync` gate plus a `typeof content !== 'string'`
  check, and its `readFileFn` is an injected test seam. Correct as written.

### Audit status

Complete. The first pass converted the 14 sites in the upper half of the table
and named seven more as follow-ups; the second pass worked through all seven —
`taskLearning/store.js` (both files), `goalScorecard.js` (all four files),
`goalCheckIn.js`, `brainStorage.js#loadMeta`, `telegram.js#loadCheckins`,
`appActivity.js`, `mediaJobQueue/index.js#initMediaJobQueue` — and every one
turned out to be a genuine member of the class, so all seven are converted
above. Nothing from the original triage remains unclassified: every
`readJSONFile` / `tryReadFile` call site in `server/` is now either in the
converted table, in a documented-safe category above, or covered by the
category rule for classifying a new one.

### Failure shapes, and when a throw is the wrong answer

The second pass added two postures the first pass had no instance of, both
driven by *where the caller runs* rather than by what the value feeds:

- **A caller outside the request lifecycle that nothing awaits** must use a
  null sentinel, not a throw. `telegram.js`'s readers run inside
  `bot.on(...)` handlers that node-telegram-bot-api never awaits, so a
  rejection becomes an unhandled rejection instead of reaching anyone who could
  act on it.
- **A boot step whose rejection is fatal** must degrade rather than throw.
  `initMediaJobQueue` is an awaited step of `runPostRouteSequence`, where any
  rejection calls `onFatal` (`process.exit(1)`) — so a bad permission bit on one
  snapshot file would take the whole server down. It reports, boots empty, and
  latches its writer off so the unreadable file is preserved rather than
  overwritten. **"Refuse to write" is the fallback whenever "refuse to
  continue" is too expensive.**

A related trap worth stating once: **the default value must not be shared
mutable state.** `loadAppActivity` returned `{ ...DEFAULT_ACTIVITY }`, whose
`apps` and `global` were the module-level objects themselves, so the first
write against an *absent* file mutated the default in place and leaked into
every later load. Deep-clone a default that callers mutate (the neighbouring
`loadLearningData` already did, via `structuredClone`).

## Consequences

- A present-but-unreadable file on a converted path now surfaces as an error
  instead of a fake zero, and no longer gets overwritten by the next save.
- **Exhaustive `vi.mock('../lib/fileUtils.js', () => ({ … }))` factories must
  list every export the module under test transitively imports.** Adding
  `tryReadFileStrict` to `settings.js` broke two such suites with a "not defined
  on the mock" throw, and the second pass had to add `readJSONFileStrict` to
  three (`routes/pipeline.test.js`, `services/autonomousJobs.test.js`,
  `services/telegram.test.js`). Prefer the `importActual`-spread form in new
  tests.
- **A `makePathsProxy` temp-root mock in a suite with static imports needs a
  lazily-allocated root.** `vi.mock` is hoisted above the file's `import`
  statements, so a `const TEST_DATA_ROOT = mkdtempSync(…)` is still in its TDZ
  when the module under test resolves its file paths at load. Use the `var` +
  hoisted-function-declaration form (`dataRoot: () => getTempRoot()`), as
  `brainStorage.test.js` does. Suites that `await import(...)` the module under
  test after the top-level `const` are unaffected.
- **Corrupt JSON — not a `chmod`/EACCES fixture — is how these tests produce
  "present but unreadable".** It exercises the identical `ok: false` branch,
  fails the parse the same way on every platform including Windows CI, and needs
  no privileges.
- The remaining ~200 swallowing call sites are documented above by category
  rather than individually, so a future reader can classify a *new* call site
  without re-deriving the rule.
