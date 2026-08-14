# client/src/utils/ — pure formatting & compute helpers

Lightweight, mostly-pure helpers used by pages, components, and hooks: formatters, time math,
small functional utilities, the CyberCity scene-compute functions, and a few thin
browser-storage / file-read / module-loading helpers. **Before writing a helper here, grep
this catalog first** — many domain patterns already have one. When you add a new module, add
it to `index.js` AND add a row here.

State + lifecycle hooks live in `client/src/hooks/`. Shared client helpers with prompt/canon
logic (and server mirrors) live in `client/src/lib/`. HTTP/socket clients live in
`client/src/services/`.

## Discovery rule

```
grep -i "what you want to do" client/src/utils/README.md
```

---

## Formatting & time

| Module | Purpose |
|---|---|
| `formatters` | Date/time/duration/byte/word formatters (`clamp`, `formatBytes`, `formatCompactCount`, `timeAgo`, `formatTimecode`, `formatDurationMs`, `formatDateShort`, `parseTimeoutMs`, `formatCooldown`, `recommendedRamGb`, `nameFromImageFilename`, `formatUsd` — one USD renderer (`signed` puts the minus outside the `$`; `trimWhole` drops `.00` on a typed round price) — `formatWeight` / `formatPercent` — round unit-converted floats (`170.35000000000002` → `170.4 lbs`) so raw binary precision never reaches a tile — `middleTruncate` — clip a long string from the MIDDLE so its distinguishing tail survives, where CSS `line-clamp`/`text-overflow` always eats the end — …) plus timeout-input bounds and `getAppName`. Do not re-define formatters inside components. **Never write `new Date(x).toLocaleDateString()` inline** — pick the helper for the shape you want: `formatDateNumeric` ("3/5/2026", compact cells), `formatDateShort` ("Mar 5, 2026"), `formatDate` ("March 5, 2026"), `formatDateFull` ("Saturday, March 5, 2026"), `formatWeekdayDate` ("Monday, Mar 5", `{ weekday, year }`), `formatMonthDay` ("Mar 5"), `formatMonthYear` ("March 2026"), `formatWeekdayShort` ("Mon"), `formatWeekdayTime` ("Mon, 7:00 AM"), `formatTimeOfDay` ("1:30 PM"), `formatTimeOfDaySeconds` ("1:30:45 PM", log/queue rows), `formatClockTime` ("02:30:45 PM"; `{ seconds, hour12, timeZone }`), `formatDateTime`. All of them anchor a bare `YYYY-MM-DD` at LOCAL midnight (a naive `new Date('2026-03-05')` is UTC midnight and renders as the previous day west of Greenwich) and take a fallback instead of rendering the literal "Invalid Date". |
| `cronHelpers` | Cron preset list, `isCronExpression` detection, and `describeCron` human-readable rendering. |
| `markdownText` | `markdownToPlainText(md)` — flatten markdown source to one plain-text string for a clamped preview: strips heading/list/blockquote/fence markers, unwraps emphasis, inline code and links, images → `[alt]`, collapses blank-line runs. Use whenever a card previews arbitrary agent-authored markdown — `line-clamp-N` does not clamp a subtree of block elements, and foreign `##` headings would otherwise join the page's heading outline. Underscore emphasis is word-boundary gated and `__…__` needs interior whitespace, so stack frames and user-agent strings (`10_15_7`, `__init__`) are never silently rewritten. `dropsMarkupWhenFlattened(md)` — did the flatten lose actual markup, as opposed to only normalizing whitespace? Gates a "Show more" disclosure so a short-but-lossy body stays reachable without putting a toggle on every body that merely lost a trailing newline. |
| `timeWindow` | Time-of-day window math (`isInTimeWindow`, `timeStringToMinutes`) and morning-layout auto-switch helpers (`pickActiveLayoutId`, `recordManualLayoutPick`). |
| `timezone` | Timezone day-key helpers (`dayKeyInTimezone`, `todayKeyInTimezone`) — browser mirror of the server's `todayInTimezone`, so date-scoped POST surfaces derive "today" in the user's configured timezone and agree with the server (#2681). |

## General pure helpers

| Module | Purpose |
|---|---|
| `animationClips` | Treadmill helpers for rigged GLB clips: `withInPlaceClips` synthesizes root-translation-stripped ("in place") variants of root-motion walk/run clips so a fixed-frame avatar can't drift; `inPlaceClipName` routes a clip name to its variant. Framework-agnostic (caller passes the root-motion names + suffix). |
| `coalesce` | Trailing-edge coalescer: wraps a function so rapid calls collapse into one deferred invocation. |
| `easing` | `smoothstep` interpolation easing curve. |
| `hashString` | Deterministic string → 32-bit hash (stable colors, keys, seeds). |
| `modelFit` | `fitModelToHeight(object, { targetHeight, feetOnGround, yOffset })` — normalize a loaded GLB to a fixed on-screen height and anchor it vertically, either by bounding-box center (portrait framing) or by its lowest point (a figure standing on a ground plane). Recenters x/z, guards a zero-height model against an infinite scale, leaves a geometry-less object or a non-finite `targetHeight` untouched rather than writing `NaN`/`Infinity` through the transform, and resets to identity before measuring so a repeat call (StrictMode's double mount effect) converges instead of blowing the model back up. Call from an effect, never during render — a skinned mesh measures wrong before `useAnimations` binds the skeleton. |
| `sleep` | `sleep(ms)` — promise-returning `setTimeout` for retry backoffs and race timeouts. Use instead of re-declaring a local `delay`. |
| `urlNormalize` | `isUrl` detection, `normalizeUrl` (optional git/`requireDot` modes), `isHttpUrl` (explicit http(s) only — safe-href check), and `tiktokVideoId` / `tiktokEmbedSrc` (host-anchored TikTok video-id extraction + its Embed Player URL, so a reference embeds without loading TikTok's embed.js). |
| `platform` | `isMac` detection and `modKey` (⌘/Ctrl) for keyboard-shortcut display. |
| `navWorkingSet` | Recent/pinned nav persistence (`recordVisit`, `togglePin`, `isPinned`) plus `resolveRecentNavEntries` for mapping stored deep links back to their longest matching nav-manifest entry. |
| `providers` | AI-provider type predicates and helpers (`isCliProvider`, `isApiProvider`, `isCodexProvider`, `isAntigravityProvider`, `filterSelectableModels`, `resolveCliEffort` (mirror — what a stored effort actually runs as, so the picker can name a clamped level), `configuredDefaultIn` — the sentinel a provider's catalog carries, so a picker can render an option matching a sentinel-valued tier instead of a blank select — `getProviderTimeout`, `resolveEffectiveProvider` — the provider a record actually runs on (its pin, else the active provider) plus whether it fell back, so a "Default" option can name what it resolves to — `resolveSeriesRunLlm` (mirror of server `seriesLlmOverride.js`: which provider/model a Pipeline **series** run resolves to — per-run override → `series.llm` → active provider) and `providerModelLabel` (the one "Provider / model" phrasing), configured-default sentinels, and the claude/codex/agy thinking-effort levels — `effortLevelsForProvider`, mirror of server `providerModels.js`). |
| `layeredIntelligenceReasons` | Canonical gloss for the Layered Intelligence loop's run-outcome reason tokens, shared by the on-demand toast and the durable "Last run" line (`formatLiReason`, `liReasonTone`, `LI_NEUTRAL_REASONS`). |

## Module loading / resilience

| Module | Purpose |
|---|---|
| `lazyWithReload` | `React.lazy` wrapper that auto-reloads once on a stale-chunk import error (post-deploy hash mismatch). |
| `staleChunkReload` | Detects stale dynamic-import chunk errors (`isStaleChunkError`) and triggers a one-time reload guard; `purgeOfflineCaches()` drops the service-worker caches so the recovery reload boots the fresh bundle. |

## File handling

| Module | Purpose |
|---|---|
| `fileUpload` | Pure screenshot/attachment upload helpers: base64 read (`readFileAsBase64`) and image validation (`validateImageFile`). Also the shared upload constants — `JSON_UPLOAD_MAX_FILE_SIZE` (max file size / wire limit, mirrors `server/lib/uploadLimits.js`), `ATTACHMENT_MAX_FILE_SIZE`, `ALLOWED_ATTACHMENT_EXTENSIONS`, and the `accept` strings `ATTACHMENT_ACCEPT` / `IMAGE_ACCEPT`. The actual upload orchestration (`processScreenshotUploads` / `processAttachmentUploads` and their single-file variants) does network I/O and lives in `services/apiMedia.js` — import those from there, not from here. |

## CyberCity — character & avatar

| Module | Purpose |
|---|---|
| `characterXp` | Character HUD badge math: `computeAgeView` (age-based level + progress to next birthday), `diffXp` (XP-gain / birthday burst diff), `birthDateCta` (missing-birth-date call to action), plus the legacy `levelFromXP` XP-curve lookup used by `cityArtifacts`. |

## CyberCity — scene compute helpers

Pure `compute*` functions that turn PortOS state into 3D-scene descriptors for the City
districts. One module per district/feature; each exports a `compute<Feature>` entry point plus
its tunable constants and placement helpers.

| Module | Purpose |
|---|---|
| `cityActivityHeatmap` | Calendar activity → per-tile heat levels (`computeActivityHeatmap`, `tileLevel`). |
| `cityAgentMotion` | Agent orbit/trail motion math (`computeAgentOrbit`, `computeAgentTrailPoints`, trail colors). |
| `cityAiCore` | AI-ops core: model tiers, beam thickness, and `computeAiCore` / `computeAiCoreBeams` from live AI status events. |
| `cityArtifacts` | Earned-artifact milestones (level/goal/streak) → placed artifact descriptors (`computeArtifacts`). |
| `cityBackupVault` | Backup-vault health/alerting state and color (`computeBackupVault`, `vaultHealth`). |
| `cityChronotype` | Chronotype energy curve by hour → brightness/tempo modifiers (`computeChronotypeEnergy`). |
| `cityDataHarbor` | Data Harbor pier district: DB table silos + data/ domain racks from /api/city/introspection (`computeDataHarbor`). |
| `cityDistrictLayout` | Shared district layout math: auto-columns, grid placement, tallying, metric→height scaling. |
| `cityEasterEggs` | Unlockable easter eggs from context (date/character/goals) → placements (`computeEasterEggs`). |
| `cityFederation` | Sync-peer reachability horizon: status color/opacity, bridge state, peer placement (`computeFederationHorizon`). |
| `cityFilter` | Status-filter definitions and app-filtering result (`computeFilterResult`). |
| `cityFocusCamera` | Pure camera-framing math for building focus mode: orbital `position`/`target` that frame one borough for a given aspect ratio + HUD safe area (`computeFocusCamera`). |
| `cityFocusState` | Resolve the `/city/apps/:appId` route param + app list into `{ hasFocus, focusedApp, notFound }`, deferring the not-found flag until apps finish loading (`resolveCityFocus`). |
| `cityFlowLines` | Inter-building flow-line connections between active/agent nodes (`computeFlowConnections`). |
| `cityGoalMonuments` | Goal monuments & forest: stall detection, milestone segments, placement (`computeGoalMonuments`, `computeGoalForest`). |
| `cityHealthTower` | Health-metric tower segments from the latest health entry (`computeHealthTower`). |
| `cityInteriorWindows` | Per-building interior-mapping window grid + selection predicate for InteriorMappingMaterial panes (`computeWindowGrid`, `buildingHasInteriorWindows`, `INTERIOR_WINDOW`). |
| `cityJiraDistrict` | Jira ticket district: ticket state, sprint structures, placement (`computeJiraDistrict`). |
| `cityMemoryDistrict` | Brain-graph memory district: category clustering, bridges, placement (`computeMemoryDistrict`). |
| `cityMiniMap` | Mini-map projection of building positions into 2D bounds, plus opt-in waterfront geography (bay/shoreline/harbor) read from `cityPlan` (`computeMiniMap`, `projectPoint`, `geographyWorldPoints`, `projectGeography`). |
| `cityPhotoMode` | Photo-mode camera presets, the demand-loop fly stepper, postcard stats, and screenshot filename (`getPreset`, `cyclePreset`, `stepFly`). |
| `cityPlan` | Master town plan: district parcels, shoreline/bay, plaza, transit loop, street network (`PARCELS`, `WORLD`, `computeStreets`, `computeStreetProps`, `isInWater`). |
| `cityPlayerRig` | Exploration player-rig math: third-person follow camera, boom collision, damping, facing, avatar state (`thirdPersonCamera`, `resolveBoom`, `dampAngle`, `moveFacing`, `avatarState`). |
| `cityRenderBudget` | Pure Auto-quality render-budget state machine: p75 frame-time windows, hysteresis, cooldown, warm-up/gap rejection (`createRenderBudget`, `recordFrame`, `restartWarmup`, `resetRenderBudget`, `getEffectiveTier`, `QUALITY_TIERS`, `DEFAULT_RENDER_BUDGET_CONFIG`). |
| `cityRooftops` | Deterministic rooftop fixture kits (antenna/tank/AC/dish) per app name (`computeRooftopKit`). |
| `cityProductivity` | Productivity monument from streak/velocity tiers (`computeProductivityMonument`). |
| `citySeasonalDecor` | Season/holiday resolution → seasonal decoration placements (`computeSeasonalDecor`). |
| `citySoundscape` | Ambient soundscape: mood/energy classification, chord selection (`computeSoundscape`), and the manual mood override (`applyMoodOverride`). |
| `cityTaskFlowRiver` | Task-flow river width/speed from backlog & throughput (`computeTaskFlowRiver`). |
| `cityTaskQueue` | Task-queue state/color from status counts (`computeTaskQueue`). |
| `cityTimeline` | Activity-log density bins and timeline buckets (`computeActivityDensity`, `buildTimelineBuckets`). |
| `cityVoiceMarker` | Voice-agent marker state/color/label from voice status (`computeVoiceMarker`). |
