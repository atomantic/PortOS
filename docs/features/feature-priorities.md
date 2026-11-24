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
