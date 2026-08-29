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
//      entry when a whole sidebar section belongs to it) and the matching rows
//      in client/src/components/Layout.jsx;
//   3. add a `detect` hook in services/instanceFeatures.js when a fresh install
//      should infer the default from whether the integration is configured.
// The validation schemas and the install-wide Features tab pick it up with no
// further edit; managed-app tabs opt into the separate APP_FEATURE_IDS list
// below when they need an app-level inherit/override control.
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
    id: 'gsd',
    label: 'GSD',
    description: 'Get Stuff Done project planning and progress tracking for managed apps.',
    defaultEnabled: true,
  }),
  Object.freeze({
    id: 'openclaw',
    label: 'OpenClaw',
    description: 'Operator chat with a configured OpenClaw runtime.',
    // Preserve the existing behavior for installs that already configured
    // OpenClaw; an explicit Settings > Features toggle remains authoritative.
    defaultEnabled: true,
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
    id: 'facetime',
    label: 'FaceTime Audio',
    description: 'Machine-local FaceTime Audio call controls and setup checks.',
    defaultEnabled: false,
  }),
]);

export const INSTANCE_FEATURE_IDS = Object.freeze(INSTANCE_FEATURES.map((feature) => feature.id));

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
