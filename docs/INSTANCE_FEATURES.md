# Optional instance features

How per-install optional features (`post`, `datadog`, `jira`, the `comms`
integrations, …) are declared, resolved, gated in navigation, grouped under one
toggle, and kept in sync with the background work they arm. The rules here are
the long form of the "Optional features gate navigation, not routes" paragraph
in the root `AGENTS.md`; the `portos-add-page` skill covers the nav-manifest
entry itself.

## Registry and resolution

`server/lib/instanceFeatureRegistry.js` declares every optional feature the user
toggles in **Settings > Features**. `server/services/instanceFeatures.js`
resolves each one as **stored override → auto-detection of the integration it
fronts → `defaultEnabled`**.

## Navigation gating (client-side, on purpose)

A nav entry tagged `feature: '<id>'` (or living in a section listed in
navManifest's `SECTION_FEATURE` map) drops out of `⌘K` and the sidebar while
that feature is off. **The `<Route>` keeps working**, so bookmarks, direct
links, and voice `ui_navigate` still resolve.

The gate is applied CLIENT-side (`useInstanceFeatures` +
`client/src/lib/navFeatures.js`), not by filtering the manifest response: `⌘K`
and the voice widget each fetch `/api/palette/manifest` once per session and it
is HTTP-cached, so a server-side filter would both defeat that cache and still
show hidden pages until a reload.

A sidebar row still needs its own `NAV_PRESENTATION` entry in
`client/src/lib/navPresentation.js` (path → icon), which `Layout.jsx` iterates.
`feature`, `section` and `label` are inherited from `NAV_COMMANDS`, so the path
is the one thing declared twice — the icon lives only in `NAV_PRESENTATION` —
and a manifest tag alone yields no sidebar row: `NAV_PRESENTATION`'s keys are
the set the sidebar iterates. `Layout.test.jsx` pins that every Settings,
Digital Twin and Messages sub-tab path has a `NAV_PRESENTATION` entry, and that
each entry stays presentation-only (an icon, no `to`/`label`/`section`/`feature`)
keyed to a live manifest path. `navManifest.test.js` fails when a tag names an
unregistered feature, or when a `SECTION_FEATURE` key stops matching a live
section.

## Feature groups (one toggle, additive)

`INSTANCE_FEATURE_GROUPS` in `server/lib/instanceFeatureRegistry.js` declares
the groups (today: `comms`, holding FaceTime Audio, iMessage, Signal, X,
Stacker News and Beeper). A feature joins one by carrying `group: '<groupId>'`
on its descriptor — that is the whole edit.

`resolveOne` in `server/services/instanceFeatures.js` resolves a grouped
feature as **its own stored override → the group flag → the detector →
`defaultEnabled`**: an explicit per-feature override always wins, and only a
feature left on "inherit" answers to its group (group off hides it, group on
hands it straight back to its normal resolution). Setting an override back to
inherit deletes the stored key rather than writing a third sentinel, so it
reads exactly like a feature nobody ever touched.

**A group's own `enabled` defaults to `true` when no group state is stored.**
That default is the parity guarantee: an install with no
`instanceFeatureGroups` in settings resolves every member exactly as it did
before the group existed, so registering a group is never a silent hide and
needs no settings migration. Malformed group settings fail toward `false`,
matching the per-feature override's own posture. An ungrouped feature is
completely unaffected.

## A toggle that arms background work reconciles at toggle time

A subsystem gated on "feature on AND credential present" and started once in
`services/bootstrap.js` is silently wrong the moment either half of that gate
moves at runtime. On a live install, storing a Beeper credential left the
realtime transport down and no sweep registered for 48 minutes, until a
restart — and the mirror-image gap left a socket relaying on a token a
disconnect had just revoked.

Give the subsystem one idempotent `reconcile…()` that reads the gate and moves
everything to match it, and call it from every path that can move the gate
(each credential write, the feature toggle, the group toggle, disconnect).
Make repeat calls no-ops rather than re-registrations — re-`schedule()`ing an
existing event resets `nextRunAt` a full interval out, so an unrelated toggle
would keep pushing the next run away — serialize overlapping calls on one
tail, and log transitions only, so an install that has never enabled the
feature still narrates nothing. `server/services/beeperArming.js` is the
worked example.
