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
| `formatters` | Date/time/duration/byte/word formatters (`formatBytes`, `formatCompactCount`, `timeAgo`, `formatTimecode`, `formatDurationMs`, `formatDateShort`, `parseTimeoutMs`, `formatCooldown`, `parseSizeGb`, `recommendedRamGb`, …) plus timeout-input bounds and `getAppName`. Do not re-define formatters inside components. |
| `cronHelpers` | Cron preset list, `isCronExpression` detection, and `describeCron` human-readable rendering. |
| `timeWindow` | Time-of-day window math (`isInTimeWindow`, `timeStringToMinutes`) and morning-layout auto-switch helpers (`pickActiveLayoutId`, `recordManualLayoutPick`). |
| `timezone` | Timezone day-key helpers (`dayKeyInTimezone`, `todayKeyInTimezone`) — browser mirror of the server's `todayInTimezone`, so date-scoped POST surfaces derive "today" in the user's configured timezone and agree with the server (#2681). |

## General pure helpers

| Module | Purpose |
|---|---|
| `coalesce` | Trailing-edge coalescer: wraps a function so rapid calls collapse into one deferred invocation. |
| `easing` | `smoothstep` interpolation easing curve. |
| `hashString` | Deterministic string → 32-bit hash (stable colors, keys, seeds). |
| `urlNormalize` | `isUrl` detection, `normalizeUrl` (optional git/`requireDot` modes), and `isHttpUrl` (explicit http(s) only — safe-href check). |
| `platform` | `isMac` detection and `modKey` (⌘/Ctrl) for keyboard-shortcut display. |
| `navWorkingSet` | Recent/pinned nav persistence (`recordVisit`, `togglePin`, `isPinned`) plus `resolveRecentNavEntries` for mapping stored deep links back to their longest matching nav-manifest entry. |
| `providers` | AI-provider type predicates and helpers (`isCliProvider`, `isApiProvider`, `isCodexProvider`, `filterSelectableModels`, `getProviderTimeout`, configured-default sentinels, and the claude/codex thinking-effort levels — `effortLevelsForProvider`, mirror of server `providerModels.js`). |
| `layeredIntelligenceReasons` | Canonical gloss for the Layered Intelligence loop's run-outcome reason tokens, shared by the on-demand toast and the durable "Last run" line (`formatLiReason`, `liReasonTone`, `LI_NEUTRAL_REASONS`). |

## Module loading / resilience

| Module | Purpose |
|---|---|
| `lazyWithReload` | `React.lazy` wrapper that auto-reloads once on a stale-chunk import error (post-deploy hash mismatch). |
| `staleChunkReload` | Detects stale dynamic-import chunk errors (`isStaleChunkError`) and triggers a one-time reload guard; `purgeOfflineCaches()` drops the service-worker caches so the recovery reload boots the fresh bundle. |

## File handling

| Module | Purpose |
|---|---|
| `fileUpload` | Screenshot/attachment upload helpers: base64 read plus `processScreenshotUploads` / `processAttachmentUploads` and their single-file variants. |

## CyberCity — character & avatar

| Module | Purpose |
|---|---|
| `characterXp` | Character HUD badge math: `computeAgeView` (age-based level + progress to next birthday), plus legacy XP helpers `levelFromXP`, `computeXpView`, `diffXp` and the XP threshold table. |

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
| `citySoundscape` | Ambient soundscape: mood/energy classification and chord selection (`computeSoundscape`). |
| `cityTaskFlowRiver` | Task-flow river width/speed from backlog & throughput (`computeTaskFlowRiver`). |
| `cityTaskQueue` | Task-queue state/color from status counts (`computeTaskQueue`). |
| `cityTimeline` | Activity-log density bins and timeline buckets (`computeActivityDensity`, `buildTimelineBuckets`). |
| `cityVoiceMarker` | Voice-agent marker state/color/label from voice status (`computeVoiceMarker`). |
