// The registry of optional per-install features — the single list that Settings
// > Features renders, `server/lib/validation.js` validates against, and
// `server/lib/navManifest.js` gates navigation on.
//
// It lives in lib/ (pure data, no I/O) so both a lib and a service can read it
// without a service→lib inversion. Runtime resolution — stored overrides,
// auto-detection, the enabled/disabled answer — is
// `server/services/instanceFeatures.js`.
//
// Adding a feature:
//   1. add a descriptor here;
//   2. tag its pages in navManifest.js (`feature: '<id>'`, or a SECTION_FEATURE
//      entry when a whole sidebar section belongs to it) — a sidebar row also
//      needs its own NAV_PRESENTATION entry in client/src/components/Layout.jsx
//      (path → icon): feature, section and label are inherited from
//      NAV_COMMANDS, so the path is the one thing declared twice — the icon
//      lives only in NAV_PRESENTATION;
//   3. add a `detect` hook in services/instanceFeatures.js when a fresh install
//      should infer the default from whether the integration is configured.
// The validation schemas and the install-wide Features tab pick it up with no
// further edit; managed-app tabs opt into the separate APP_FEATURE_IDS list
// below when they need an app-level inherit/override control.
//
// A feature may carry `group: '<groupId>'` to bucket it under one of
// INSTANCE_FEATURE_GROUPS below. A grouped feature keeps its own tri-state
// override (inherit/on/off, same stored-`enabled` shape every feature already
// uses) but ALSO inherits its group's `enabled` flag when its own override is
// untouched: group off hides every member that has not overridden on, group on
// hands each member back to its own normal resolution (detector, then
// `defaultEnabled`). See resolveOne in services/instanceFeatures.js. An
// ungrouped feature is completely unaffected — this is additive.
export const INSTANCE_FEATURES = Object.freeze([
  Object.freeze({
    id: 'post',
    label: 'POST',
    description: 'Daily cognitive practice, progress metrics, and reminder prompts.',
    defaultEnabled: true,
  }),
  Object.freeze({
    id: 'datadog',
    label: 'DataDog',
    description: 'Error monitoring dashboards for apps wired to a DataDog instance.',
    defaultEnabled: false,
  }),
  Object.freeze({
    id: 'jira',
    label: 'JIRA',
    description: 'Sprint boards, ticket triage, and JIRA reports for apps wired to a JIRA instance.',
    defaultEnabled: false,
  }),
  Object.freeze({
    id: 'eidoverse',
    label: 'Eidoverse Worlds',
    description: 'An optional shared 3D world for you and your agents, installed as a separately managed app.',
    defaultEnabled: false,
  }),
  Object.freeze({
    id: 'gsd',
    label: 'GSD',
    description: 'Get Stuff Done project planning and progress tracking for managed apps.',
    defaultEnabled: false,
  }),
  Object.freeze({
    id: 'openclaw',
    label: 'OpenClaw',
    description: 'Operator chat with a configured OpenClaw runtime.',
    defaultEnabled: false,
  }),
  Object.freeze({
    id: 'health',
    label: 'Health tracking',
    description: 'Personal health tracking, MeatSpace records, and MortalLoom iCloud sync.',
    // Health and MortalLoom were previously always visible. Keep existing
    // installs on that behavior until the user explicitly changes the flag.
    defaultEnabled: true,
  }),
  Object.freeze({
    id: 'rigging',
    label: 'Character rigging',
    description: 'Blender-backed rigging for generated 3D characters. Needs a provisioned Blender Python runtime on this machine.',
    // Off until a runtime is actually present: the detector in
    // services/instanceFeatures.js turns it on only when the probe says the Blender
    // module imports, so a fresh install never advertises a capability it cannot run.
    defaultEnabled: false,
  }),
  Object.freeze({
    id: 'facetime',
    label: 'FaceTime Audio',
    description: 'Machine-local FaceTime Audio call controls and setup checks.',
    defaultEnabled: false,
    group: 'comms',
  }),
  Object.freeze({
    id: 'imessage',
    label: 'iMessage',
    description: 'Machine-local iMessage and SMS reading, spam blocklist, and Tribe sync.',
    defaultEnabled: true,
    group: 'comms',
  }),
  Object.freeze({
    id: 'signal',
    label: 'Signal',
    description: 'Machine-local Signal Desktop message reading and Tribe sync.',
    defaultEnabled: true,
    group: 'comms',
  }),
  Object.freeze({
    id: 'x',
    label: 'X',
    description: 'X (Twitter) reach and health tracking, draft posts, and account safety controls.',
    defaultEnabled: true,
    group: 'comms',
  }),
  Object.freeze({
    id: 'stacker-news',
    label: 'Stacker News',
    description: 'Stacker News community monitoring, triage queue, and draft composition.',
    defaultEnabled: true,
    group: 'comms',
  }),
  Object.freeze({
    id: 'beeper',
    label: 'Beeper',
    description: 'Local Beeper Desktop bridge — WhatsApp, Discord, Telegram, and other bridged networks, mirrored machine-local.',
    // No detector, by design (fork issue #11 decision): a token-presence gate
    // can't bootstrap the very screen that sets the token. A plain manual
    // toggle, off by default, like every other feature with no detector.
    defaultEnabled: false,
    group: 'comms',
  }),
]);

export const INSTANCE_FEATURE_IDS = Object.freeze(INSTANCE_FEATURES.map((feature) => feature.id));

// Buckets features under one group toggle with per-feature overrides (#40).
// Membership: comms (FaceTime Audio, iMessage, Signal, X, Stacker News, Beeper
// — #30 joined Beeper to the group #40 stood up, and X/Stacker News joined
// after). Widening membership is a one-line change to a feature's `group`
// above; adding a new group is a one-line addition here. A group's own
// `enabled` flag defaults to true (see storedGroupEnabled in
// services/instanceFeatures.js) so registering this never hides a feature an
// existing install already saw with no settings write required.
export const INSTANCE_FEATURE_GROUPS = Object.freeze([
  Object.freeze({
    id: 'comms',
    label: 'Comms',
    description: 'Chat and calling integrations, bucketed under one group toggle.',
  }),
]);

export const INSTANCE_FEATURE_GROUP_IDS = Object.freeze(INSTANCE_FEATURE_GROUPS.map((group) => group.id));

// These are the feature tabs shown on a managed app. POST is install-wide only;
// it has no app-level tab or override. Keep this list next to the registry so
// the app schema and client resolver cannot drift from the feature catalog.
export const APP_FEATURE_IDS = Object.freeze(['datadog', 'jira', 'gsd']);

/**
 * How many instances an integration's config file declares — the signal every
 * `detect` hook is built on.
 *
 * THROWS on a malformed shape rather than counting it, because every wrong
 * answer here is silently wrong: `{"instances": "bad"}` would count its three
 * CHARACTER keys as three configured instances, and `{"instances": []}` (or
 * `null`) would report a confident zero. Both are "the file is not what we
 * think", which the caller must treat as detection failure — not as a
 * trustworthy count. An absent file never reaches here; it resolves to the
 * empty default upstream, which is a trustworthy zero.
 */
export const countConfiguredInstances = (config, label = 'instance config') => {
  const instances = config?.instances;
  const isPlainObject = instances !== null
    && typeof instances === 'object'
    && !Array.isArray(instances);
  if (!isPlainObject) {
    throw new Error(`Malformed ${label}: "instances" must be an object`);
  }
  return Object.keys(instances).length;
};
