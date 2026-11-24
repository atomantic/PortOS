# Feature priorities

Each feature area gets a tier, `P0` (heavy daily use) to `P3` (dormant), that scheduled audits read to decide where to spend scan effort. The catalog of areas is `server/lib/featureAreas.js`, the scoring is `server/lib/featurePriorityScoring.js`, and this page covers the install-local usage signal, pins and API (`server/services/featurePriorities.js`, `server/routes/featurePriorities.js`).

## Usage signal

A hook mounted once beside the router (`client/src/components/featureUsage/useFeatureUsageBeacon.js`) posts `POST /api/feature-priorities/visit { path }` when the current route has been continuously visible and focused for 10 seconds, then at most once per route every 6 hours (a tab left open across days keeps contributing, and the server counts extra posts harmlessly because only distinct days score). A failed post is dropped without a retry or a toast. API traffic is not counted: dashboard widgets and sidebar badges call most feature APIs on every load, and an agent crawling a background tab has no focus.

The server maps the path to an area through `areaForNavPath`; a path no area owns is a no-op. A visit is one upsert on `feature_usage_days (area_id, day)` (the server's local calendar day), followed by deleting rows older than 90 days.

The route accepts a visit only from an operator caller. A `peer` or `basic` `req.portosAuthContext.method` is refused with `403 OPERATOR_REQUIRED`, and a session minted for a spawned agent (`label: 'agent'`) is skipped (`{ recorded: false }`). The agent check is inert on a password-free install, which is why dwell is the primary filter.

## Storage

`feature_usage_days` is `db-primary`, machine-local and never federated, with the same rationale as `user_action_events`: usage describes one human on one install. It is excluded from peer sync (guarded in `server/services/sharing/peerSync.test.js`) and stays out of `auditedTables`. Usage counts and dates never enter a log line, a prompt, a federation payload or `.quality.json`.

Pins are stored at `settings.featurePriorities.overrides[areaId]` as `P0`-`P3`; an absent key means auto.

## Resolution

First match wins: a pin, then the feature-off rule (an optional area whose instance feature is disabled and has no visit in 30 days is `P3`), then the tier learned from usage once the install has 14 distinct active days, then `P1`. Corrupt settings read as unknown: no pins and no feature-off demotion.

## API

- `GET /api/feature-priorities` returns `{ areas, evidenceDays, minEvidenceDays }`; each area is `{ areaId, label, instanceFeatureId, tier, source, activeDays30, lastActiveDay }` and `source` is `pinned`, `feature-off`, `learned` or `default`.
- `PUT /api/feature-priorities/:areaId` with `{ tier: 'P0'|'P1'|'P2'|'P3'|null }` sets or clears a pin (`null` clears it) and emits `feature-priorities:updated` with `{ areaId, tier }`.
- `POST /api/feature-priorities/visit` with `{ path }` is the beacon above and answers `{ recorded }`.

## Audit scope

When a scheduled audit of PortOS itself is prepared, `resolveAuditPriorityScope(app, taskType)` turns the resolved tiers into `{ exempt, p0, p2, p3 }`, each a list of `{ label, globs }` from the catalog. `auditQualityInstructions(taskType, app, { priorityScope })` renders it as a `Feature priority scope` section ahead of the reachability check. The scope carries tiers and globs only: no usage count, date or tier source reaches a prompt, and the section tells the agent not to restate tiers in issues, pull requests or commit messages.

| Tier | Security, privacy and data-integrity audits | Every other audit |
| :--- | :--- | :--- |
| `P0` | Not mentioned | First tie-break after severity and user impact, ahead of churn and fan-in; preferred when rotating slices |
| `P1`, and every file in no area | Not mentioned | Unchanged |
| `P2` | Not mentioned | Verified functional or reliability defects only |
| `P3` | Listed as fully in scope | Removed from the inventory and from slice rotation, so `totalFiles`, `scannedFiles` and `coverage: "broad"` count `P0`-`P2`; a verified defect met while tracing other code is still filed |

A scope with nothing to say (no `P0`, `P2` or `P3` area, or no `P3` area for an exempt audit) adds no section, and the prompt is byte-identical to the unscoped one. If the tiers cannot be resolved (the usage store is unreachable), the audit is dispatched unscoped and the skip is logged; a failed lookup never reads as "everything is dormant".

The complexity audits (`better-complexity`, `code-simplification`) also get a ready command that leaves the `P3` paths out of the shortlist: `npm run quality:complexity -- --exclude '<glob>'`, one `--exclude` per glob. `--exclude` takes the same `path.matchesGlob` patterns the catalog uses, drops matching files from the source and test shortlists and prints how many it excluded.

Subtracting an area's globs is exact because no tracked file belongs to two areas (guarded in `server/test/guards/repo/featureAreaCatalog.test.js`).

## Settings UI

Settings > Features ends with an "Audit priority" section (`client/src/components/settings/FeaturePrioritiesSection.jsx`). Each area shows its effective tier, a source badge (`Pinned`, `Learned`, `Feature off`, `Default`) and "active N of the last 30 days"; below 14 days of evidence it says "Still learning" instead, since every enabled area then resolves to `P1`. The `Auto | P0 | P1 | P2 | P3` control calls `PUT /api/feature-priorities/:areaId`. A pin applies from the response; `Auto` and a clear announced by another tab on `feature-priorities:updated` reload the list once, because the response carries only the pin, not the re-resolved tier. There is no timer.

## Managed apps

A managed app has no feature-area catalog and nothing PortOS can observe, so its priorities are written by hand and nothing is learned. **Edit App > Workflow > Audit priorities** edits the optional `featurePriorities` array on the app record (the editor is not offered for PortOS itself):

```json
[{ "id": "legacy", "label": "Legacy importer", "paths": ["legacy/**", "scripts/import-*.js"], "priority": "P3", "note": "optional, never sent to audits" }]
```

- Up to 50 entries; `id` is unique, trimmed and at most 64 characters; `label` at most 80; 1 to 20 `paths` of at most 200 characters; `priority` is `P0` to `P3`; `note` at most 500.
- `label` and `paths` are written into audit prompts (a glob sits between backticks and inside the single-quoted `--exclude '...'` argument), so a control character, newline, single quote or backtick is refused at validation.
- Globs are `path.matchesGlob` patterns over repository-relative paths. A path no entry names is `P1`, so `P1` rows only document intent.
- A `P3` path must not contain or sit inside a `P0` or `P2` path (`src/**` as `P3` beside `src/checkout/**` as `P0` is refused), because `P3` paths are removed from the inventory and from the complexity shortlist and glob containment cannot be resolved in general. The check compares literal directory prefixes (`server/lib/appFeaturePriorityRules.js`); a prefix-less glob such as `**/*.snap` is treated as a file-type exclusion and not compared, while a repository-wide glob (`**`, `**/*`) on either side conflicts with every path on the other. `P0` and `P2` overlaps only reorder work and are allowed.
- The field is local app metadata: an app saved before it existed loads and saves unchanged, `PUT /api/apps/:id` replaces the whole array (an empty array clears it), and no migration is involved. It is not an input to the per-install tier resolution above.

`resolveAuditPriorityScope` builds the same `{ exempt, p0, p2, p3 }` shape from those entries (never reading the usage store), `cosManagedAppPreparation.js` passes it to `auditQualityInstructions` as it does for PortOS, and the exempt lanes behave identically. An app with no entries gets no scope, so its prompt is unchanged. The `quality:complexity` exclusion line is worded as applying only where the repository has that script; the complexity discovery step already falls back to another analyzer when it is absent.

The app's **Quality** tab shows an **Audit scope** summary (count per tier, expandable to the paths) when the app has entries.
