// Runtime resolution for the credential registry in
// server/lib/credentialRegistry.js. One page answers "which of PortOS's
// features are dark on this install, and what credential would light them
// up?" Presence and source only — never the value, and not a masked prefix.
//
// Source vocabulary (most specific first):
//   settings  — settings.json (or a sibling store the existing tab writes)
//   env-file  — the install's repo `.env`
//   env       — inherited process.env (shell / OS / PM2)
//   cli       — a CLI login (e.g. `hf auth login`)
//   config    — an instance/account config file that is not settings.json
//   none      — not configured
// Settings win over env, matching hfToken.js / loras.js. When process.env and
// `.env` carry the same non-empty value, `.env` is the more specific origin.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CREDENTIALS } from '../lib/credentialRegistry.js';
import { INSTANCE_FEATURES } from '../lib/instanceFeatureRegistry.js';
import { PATHS, readJSONFile } from '../lib/fileUtils.js';
import { parseEnvContents } from '../lib/vllmQwenProvision.js';
import { getSettings } from './settings.js';

export const CREDENTIAL_SOURCES = Object.freeze([
  'settings', 'env-file', 'env', 'cli', 'config', 'none',
]);

const HEADLINE = 'Most of PortOS works with no key at all.';

const isPresent = (value) => {
  if (typeof value === 'boolean') return value === true;
  if (typeof value !== 'string') return false;
  return value.trim().length > 0;
};

const getPath = (obj, path) => {
  if (!path || obj == null || typeof obj !== 'object') return undefined;
  return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
};

const firstPresentEnvKey = (keys, bag) => {
  if (!Array.isArray(keys) || keys.length === 0) return null;
  return keys.find((key) => isPresent(bag?.[key])) || null;
};

const firstPresentEnvFileKey = (keys, envFile) => {
  if (!Array.isArray(keys) || keys.length === 0 || !envFile) return null;
  return keys.find((key) => isPresent(envFile.get(key))) || null;
};

const classifyEnvSource = (envVars, env, envFile) => {
  const processKey = firstPresentEnvKey(envVars, env);
  const fileKey = firstPresentEnvFileKey(envVars, envFile);
  if (processKey && fileKey && env[processKey] === envFile.get(fileKey)) {
    return { configured: true, source: 'env-file' };
  }
  if (processKey) return { configured: true, source: 'env' };
  if (fileKey) return { configured: true, source: 'env-file' };
  return { configured: false, source: 'none' };
};

export async function loadInstallEnvFile(envPath = join(PATHS.installRoot, '.env')) {
  try {
    return parseEnvContents(await readFile(envPath, 'utf8'));
  } catch {
    return new Map();
  }
}

const detectHuggingFaceCli = async () => {
  const { getHfTokenInfo } = await import('./hfToken.js');
  const { source } = await getHfTokenInfo();
  if (source === 'cli') return { configured: true, source: 'cli' };
  return null;
};

const detectJira = async () => {
  const { hasConfiguredInstances } = await import('./jira.js');
  return (await hasConfiguredInstances()) ? { configured: true, source: 'config' } : null;
};

const detectDatadog = async () => {
  const { hasConfiguredInstances } = await import('./datadog.js');
  return (await hasConfiguredInstances()) ? { configured: true, source: 'config' } : null;
};

const detectSpotify = async () => {
  const { getAuthStatus } = await import('./spotifyAuth.js');
  const status = await getAuthStatus();
  return (status.hasCredentials || status.hasTokens)
    ? { configured: true, source: 'config' }
    : null;
};

const detectStackerNews = async () => {
  const { listAccounts } = await import('./stackerNews.js');
  const accounts = await listAccounts();
  return accounts.some((account) => account.apiKeyConfigured)
    ? { configured: true, source: 'config' }
    : null;
};

const detectOpenclaw = async () => {
  const fileConfig = await readJSONFile(join(PATHS.data, 'openclaw', 'config.json'), {}, { logError: false });
  return (isPresent(fileConfig.authToken) || isPresent(fileConfig.baseUrl))
    ? { configured: true, source: 'config' }
    : null;
};

const DEFAULT_DETECTORS = Object.freeze({
  huggingface: detectHuggingFaceCli,
  jira: detectJira,
  datadog: detectDatadog,
  spotify: detectSpotify,
  'stacker-news': detectStackerNews,
  openclaw: detectOpenclaw,
});

const resolveFromSettingsAndEnv = (entry, { settings, env, envFile }) => {
  if (entry.settingsPath && isPresent(getPath(settings, entry.settingsPath))) {
    return { configured: true, source: 'settings' };
  }
  return classifyEnvSource(entry.envVars, env, envFile);
};

const publicRow = (entry, resolution, featuresById) => {
  const feature = entry.feature ? featuresById.get(entry.feature) : null;
  const unavailableFeatures = (entry.feature && !resolution.configured && feature)
    ? [{ id: feature.id, label: feature.label }]
    : [];
  return {
    id: entry.id,
    label: entry.label,
    unlocks: entry.unlocks,
    tier: entry.tier,
    getUrl: entry.getUrl,
    configurePath: entry.configurePath,
    feature: entry.feature ?? null,
    configured: resolution.configured,
    source: resolution.source,
    unavailableFeatures,
  };
};

const assertNoSecretPayload = (row) => {
  // Defense in depth: a future detector that accidentally forwarded a token
  // must fail the response rather than render it. Presence flags only.
  for (const value of Object.values(row)) {
    if (typeof value === 'string' && /^(hf_|sk-|ghp_|gho_|github_pat_|xox[baprs]-)/.test(value)) {
      throw new Error(`Credential inventory leaked a secret-shaped value on ${row.id}`);
    }
  }
  return row;
};

export async function getCredentialInventory({
  settings,
  env = process.env,
  envFile,
  features = INSTANCE_FEATURES,
  detectors = {},
} = {}) {
  const resolvedSettings = settings ?? await getSettings();
  const resolvedEnvFile = envFile ?? await loadInstallEnvFile();
  const resolvedDetectors = { ...DEFAULT_DETECTORS, ...detectors };
  const featuresById = new Map((features || []).map((feature) => [feature.id, feature]));

  const credentials = [];
  for (const entry of CREDENTIALS) {
    let resolution = resolveFromSettingsAndEnv(entry, {
      settings: resolvedSettings,
      env,
      envFile: resolvedEnvFile,
    });
    if (!resolution.configured && typeof resolvedDetectors[entry.id] === 'function') {
      const detected = await resolvedDetectors[entry.id](entry, {
        settings: resolvedSettings,
        env,
        envFile: resolvedEnvFile,
      }).catch((error) => {
        console.error(`❌ Credential "${entry.id}" detection failed: ${error.message}`);
        return null;
      });
      if (detected?.configured) resolution = detected;
    }
    credentials.push(assertNoSecretPayload(publicRow(entry, resolution, featuresById)));
  }

  return { headline: HEADLINE, credentials };
}
