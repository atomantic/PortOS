import { ServerError } from '../lib/errorHandler.js';
import { getOriginInfo } from '../lib/gitRemote.js';
import { parseGitHubUrl } from '../lib/repoUrl.js';
import { INSTANCE_FEATURES, INSTANCE_FEATURE_IDS, INSTANCE_FEATURE_GROUPS } from '../lib/instanceFeatureRegistry.js';
import { isPlainObject } from '../lib/objects.js';
import {
  assertEidoverseInstalled,
  DEFAULT_EIDOVERSE_WORLDS_REPO,
  getEidoverseStatus,
  normalizeEidoverseWorldsRepo,
  setEidoverseWorldsOrigin,
} from './eidoverse.js';
import { getSettingsWithStatus, updateSettingsWith } from './settings.js';
import { recordUserAction } from './userActions.js';

// Runtime resolution for the feature registry in
// server/lib/instanceFeatureRegistry.js. Instance features are local to one
// PortOS install. They are deliberately separate from per-feature configuration
// so a feature can remain available when opened directly while its passive
// metrics, reminders, proactive prompts, and NAVIGATION ENTRIES stay quiet on
// installs that do not use it.
//
// A feature gates navigation by tagging nav-manifest entries with its id
// (`feature: 'jira'` in server/lib/navManifest.js) and the matching sidebar rows
// in client/src/components/Layout.jsx. Adding a page to a gated section — or to
// a section listed in navManifest's SECTION_FEATURE map — inherits the gate with
// no edit here. navManifest.test.js fails when a nav entry names a feature id
// the registry does not declare.
//
// A DETECTOR is the fresh-install default: a feature the user has never toggled
// shows up only when the integration it fronts is actually configured. It
// returns `null` when detection itself fails, which falls back to
// `defaultEnabled` rather than silently hiding a working integration.
const DETECTORS = {
  datadog: async () => {
    const { hasConfiguredInstances } = await import('./datadog.js');
    return hasConfiguredInstances();
  },
  jira: async () => {
    const { hasConfiguredInstances } = await import('./jira.js');
    return hasConfiguredInstances();
  },
  // The rigging runtime is a machine-local install, not a config file — so "configured"
  // here means the Blender module actually imports. The probe memoizes its answer, so
  // this does not spawn an interpreter on every page load's feature read.
  rigging: async () => {
    const { getRiggingReadiness } = await import('./rigging/readiness.js');
    // FAIL CLOSED, unlike the config-file detectors above. Those fail open because an
    // unreadable config file still means the integration is probably set up; here a
    // probe that could not answer means the runtime may simply not exist, and
    // advertising rigging on such a host trades a named blocker for a spawn error.
    const readiness = await getRiggingReadiness().catch((error) => {
      console.error(`❌ Rigging readiness detection failed: ${error.message}`);
      return null;
    });
    return readiness?.ready === true;
  },
  facetime: async () => {
    if (process.platform !== 'darwin') return false;
    const { checkSetup } = await import('./voice/facetimeBridge.js');
    const report = await checkSetup();
    return report.helper?.ok === 'ok' && report.identity?.ok === 'ok';
  },
};

const FEATURE_BY_ID = new Map(INSTANCE_FEATURES.map((feature) => [feature.id, feature]));
const GROUP_BY_ID = new Map(INSTANCE_FEATURE_GROUPS.map((group) => [group.id, group]));

// The stored override for one feature: `true`/`false` when the user has toggled
// it, `null` when they never have. `null` is the signal that detection (and then
// `defaultEnabled`) decides — distinct from a stored `false`, which must keep
// the feature off even once the integration is configured. Setting a grouped
// feature's override back to "inherit" (updateInstanceFeature(id, null)) drops
// the stored key entirely, so it reads `null` here exactly like a feature that
// was never touched — no third sentinel value for this function to learn.
const storedOverride = (feature, settings) => {
  const instanceFeatures = settings?.instanceFeatures;
  if (instanceFeatures === undefined) return null;
  if (!isPlainObject(instanceFeatures)) return false;
  if (!Object.prototype.hasOwnProperty.call(instanceFeatures, feature.id)) return null;

  const featureSettings = instanceFeatures[feature.id];
  if (!isPlainObject(featureSettings)) return false;
  const stored = featureSettings.enabled;
  if (stored === undefined) return null;
  return typeof stored === 'boolean' ? stored : false;
};

// A feature group's own on/off flag (#40), default `true` — opt-out, not
// opt-in — so registering a group never hides a feature an existing install
// already saw with no settings write required. Malformed shapes fail toward
// `false`, the same posture as storedOverride above: untrustworthy settings
// must not be read as a confident "on".
const storedGroupEnabled = (groupId, settings) => {
  const groups = settings?.instanceFeatureGroups;
  if (groups === undefined) return true;
  if (!isPlainObject(groups)) return false;
  if (!Object.prototype.hasOwnProperty.call(groups, groupId)) return true;

  const groupSettings = groups[groupId];
  if (!isPlainObject(groupSettings)) return false;
  const stored = groupSettings.enabled;
  if (stored === undefined) return true;
  return typeof stored === 'boolean' ? stored : false;
};

const resolveOne = (feature, settings, detected) => {
  const override = storedOverride(feature, settings);
  if (override !== null) return { enabled: override, source: 'explicit' };

  // No override: a grouped feature still answers to its group. Group OFF hides
  // every member that hasn't overridden on (handled above); group ON — the
  // default — hands the feature back to its own normal resolution below.
  if (feature.group && !storedGroupEnabled(feature.group, settings)) {
    return { enabled: false, source: 'group-off' };
  }

  const configured = detected?.[feature.id];
  if (typeof configured === 'boolean') return { enabled: configured, source: 'auto' };

  // Detection was supposed to answer and couldn't (unreadable or malformed
  // config). FAIL OPEN — show the feature — rather than falling through to
  // `defaultEnabled`, which is `false` for both integrations and would hide the
  // page on exactly the install that needs it: the config file EXISTS, so the
  // integration is probably set up, and /devtools/jira is itself where the user
  // goes to fix it. Hiding it there strands them. Mirrors the client hook, which
  // also fails open when it cannot read the feature list.
  if (typeof DETECTORS[feature.id] === 'function') {
    return { enabled: true, source: 'detect-failed' };
  }
  return { enabled: feature.defaultEnabled, source: 'default' };
};

// The resolved list Settings > Features renders for the group toggles
// themselves — parallel to resolveInstanceFeatures below, but there is no
// detection or `corrupt`-settings special case beyond storedGroupEnabled's own
// fail-closed-on-malformed-shape handling.
export const resolveInstanceFeatureGroups = (settings = {}) => (
  INSTANCE_FEATURE_GROUPS.map((group) => ({
    ...group,
    enabled: storedGroupEnabled(group.id, settings),
  }))
);

// One feature's detector: `true`/`false` when it answered, `null` when the
// feature has no detector or the probe threw — so the caller falls back to
// `defaultEnabled` rather than reading a failed probe as "not configured".
const runDetector = async (featureId) => {
  if (typeof DETECTORS[featureId] !== 'function') return null;
  const configured = await DETECTORS[featureId]().catch((error) => {
    console.error(`❌ Instance feature "${featureId}" detection failed: ${error.message}`);
    return null;
  });
  return typeof configured === 'boolean' ? configured : null;
};

export async function detectFeatureConfiguration() {
  return Object.fromEntries(await Promise.all(
    INSTANCE_FEATURE_IDS.map(async (id) => [id, await runDetector(id)]),
  ));
}

export const resolveInstanceFeatures = (settings = {}, { corrupt = false, detected = {} } = {}) => (
  INSTANCE_FEATURES.map((feature) => {
    const { enabled, source } = corrupt
      ? { enabled: false, source: 'default' }
      : resolveOne(feature, settings, detected);
    return {
      ...feature,
      enabled,
      // How `enabled` was decided, so the Features tab can say whether the user
      // set it or the install auto-detected the integration.
      source,
    };
  })
);

const configuredEidoverseRepo = (settings) => {
  const configured = settings?.instanceFeatures?.eidoverse?.worldsRepoUrl;
  if (typeof configured !== 'string') return DEFAULT_EIDOVERSE_WORLDS_REPO;
  const parsed = parseGitHubUrl(configured);
  return parsed
    ? normalizeEidoverseWorldsRepo(configured)
    : DEFAULT_EIDOVERSE_WORLDS_REPO;
};

export async function assertConfiguredEidoverseInstalled() {
  const { settings } = await getSettingsWithStatus();
  return assertEidoverseInstalled({ worldsRepoUrl: configuredEidoverseRepo(settings) });
}

const attachSetupStatus = async (features, settings) => {
  const [eidoverse, portosOrigin] = await Promise.all([
    getEidoverseStatus({ worldsRepoUrl: configuredEidoverseRepo(settings) }),
    getOriginInfo(),
  ]);
  const upstream = parseGitHubUrl(DEFAULT_EIDOVERSE_WORLDS_REPO)?.owner || null;
  const sourceOwners = {
    // A stock clone points at atomantic/PortOS, which identifies the project
    // owner rather than the current user's GitHub account. Only a non-upstream
    // GitHub origin gives us a defensible owner for the "Self" shortcut.
    self: portosOrigin.isGithub && !portosOrigin.isUpstream ? portosOrigin.owner : null,
    upstream,
  };
  return features.map((feature) => (
    feature.id === 'eidoverse' ? { ...feature, setup: { ...eidoverse, sourceOwners } } : feature
  ));
};

export async function getInstanceFeatures() {
  const [{ corrupt, settings }, detected] = await Promise.all([
    getSettingsWithStatus(),
    detectFeatureConfiguration(),
  ]);
  const features = await attachSetupStatus(resolveInstanceFeatures(settings, { corrupt, detected }), settings);
  // Corrupt settings already fail every feature closed above; mirror that for
  // groups rather than reading storedGroupEnabled's absent-key default of
  // `true` off of settings we know are untrustworthy.
  const groups = corrupt
    ? INSTANCE_FEATURE_GROUPS.map((group) => ({ ...group, enabled: false }))
    : resolveInstanceFeatureGroups(settings);
  return { features, groups };
}

export async function updateEidoverseWorldsRepo(worldsRepoUrl) {
  const normalizedRepoUrl = normalizeEidoverseWorldsRepo(worldsRepoUrl);
  await updateSettingsWith((current) => {
    const instanceFeatures = isPlainObject(current.instanceFeatures) ? current.instanceFeatures : {};
    const eidoverse = isPlainObject(instanceFeatures.eidoverse) ? instanceFeatures.eidoverse : {};
    return {
      ...current,
      instanceFeatures: {
        ...instanceFeatures,
        eidoverse: { ...eidoverse, worldsRepoUrl: normalizedRepoUrl },
      },
    };
  });
  return normalizedRepoUrl;
}

export async function updateEidoverseWorldsSource(worldsRepoUrl) {
  const normalizedRepoUrl = normalizeEidoverseWorldsRepo(worldsRepoUrl);
  await setEidoverseWorldsOrigin(normalizedRepoUrl);
  return updateEidoverseWorldsRepo(normalizedRepoUrl);
}

// The same precedence ladder as `resolveInstanceFeatures`, but probing only this
// feature's detector — the single-feature callers (reminders, metrics, signal
// readers) must not pay for the others' disk reads.
export async function isInstanceFeatureEnabled(featureId) {
  const feature = FEATURE_BY_ID.get(featureId);
  if (!feature) return false;
  const { corrupt, settings } = await getSettingsWithStatus();
  if (corrupt) return false;

  const override = storedOverride(feature, settings);
  if (override !== null) return override;
  // Same short-circuit as the override check above: a grouped feature whose
  // group is off never needs the detector run either.
  if (feature.group && !storedGroupEnabled(feature.group, settings)) return false;
  return resolveOne(feature, settings, { [featureId]: await runDetector(featureId) }).enabled;
}

export async function updateInstanceFeature(featureId, enabled) {
  if (!FEATURE_BY_ID.has(featureId)) {
    throw new ServerError(`Unknown instance feature: ${featureId}`, { status: 404, code: 'NOT_FOUND' });
  }
  if (featureId === 'eidoverse' && enabled) {
    await assertConfiguredEidoverseInstalled();
  }

  const settings = await updateSettingsWith((current) => {
    const instanceFeatures = isPlainObject(current.instanceFeatures) ? current.instanceFeatures : {};
    const currentFeature = isPlainObject(instanceFeatures[featureId]) ? instanceFeatures[featureId] : {};

    // `enabled === null` is the tri-state override going back to "inherit":
    // drop the stored `enabled` key (keeping any other co-stored key, e.g.
    // eidoverse's worldsRepoUrl) rather than writing a third sentinel value, so
    // storedOverride's existing "key absent" path picks it up unchanged.
    if (enabled === null) {
      const { enabled: _drop, ...rest } = currentFeature;
      const nextInstanceFeatures = { ...instanceFeatures };
      if (Object.keys(rest).length > 0) {
        nextInstanceFeatures[featureId] = rest;
      } else {
        delete nextInstanceFeatures[featureId];
      }
      return { ...current, instanceFeatures: nextInstanceFeatures };
    }

    return {
      ...current,
      instanceFeatures: {
        ...instanceFeatures,
        [featureId]: { ...currentFeature, enabled },
      },
    };
  }, { actor: 'user', skipUserAction: true });

  try {
    const happenedAt = new Date().toISOString();
    await recordUserAction({
      type: 'instance-feature.toggle',
      actor: 'user',
      target: featureId,
      summary: `Toggled instance feature ${featureId} ${enabled ? 'on' : 'off'}`,
      payload: { id: featureId, enabled },
      source: { service: 'instanceFeatures', fn: 'updateInstanceFeature' },
      happenedAt,
      dedupeKey: `instance-feature.toggle:${featureId}:${enabled}:${happenedAt}`,
    });
  } catch (error) {
    console.error(`❌ Failed to record instance-feature.toggle: ${error.message}`);
  }

  const detected = await detectFeatureConfiguration();
  return {
    features: await attachSetupStatus(resolveInstanceFeatures(settings, { detected }), settings),
    groups: resolveInstanceFeatureGroups(settings),
  };
}

export async function updateInstanceFeatureGroup(groupId, enabled) {
  if (!GROUP_BY_ID.has(groupId)) {
    throw new ServerError(`Unknown instance feature group: ${groupId}`, { status: 404, code: 'NOT_FOUND' });
  }

  const settings = await updateSettingsWith((current) => {
    const groups = isPlainObject(current.instanceFeatureGroups) ? current.instanceFeatureGroups : {};
    const currentGroup = isPlainObject(groups[groupId]) ? groups[groupId] : {};
    return {
      ...current,
      instanceFeatureGroups: {
        ...groups,
        [groupId]: { ...currentGroup, enabled },
      },
    };
  });

  const detected = await detectFeatureConfiguration();
  return {
    features: await attachSetupStatus(resolveInstanceFeatures(settings, { detected }), settings),
    groups: resolveInstanceFeatureGroups(settings),
  };
}
