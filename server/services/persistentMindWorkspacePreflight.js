/**
 * Read-only, bounded workspace readiness probes for the persistent mind.
 *
 * This module deliberately returns semantic facts only. Probe output, paths,
 * branch names, remotes, and arbitrary configuration values never cross the
 * service boundary. The in-memory cache is per PortOS process and is a
 * diagnostic freshness aid, not a persisted source of truth.
 */

import { opendir, readFile, readdir, stat } from 'fs/promises';
import { isAbsolute, join, relative, resolve } from 'path';
import { promisify } from 'util';
import { execFile } from '../lib/childProcess.js';
import { commandExists } from '../lib/commandExists.js';
import { execGit } from '../lib/execGit.js';
import { withSpawnCwdEnv } from '../lib/spawnCwd.js';
import { resolveAppForgeTarget } from '../lib/workTracker.js';
import {
  PERSISTENT_MIND_VALIDATION_CHECKS,
} from '../lib/persistentMindCapabilities.js';
import {
  isCliReviewer,
  REVIEWER_VALUES,
} from '../lib/validation.js';
import { compareVersions } from '../../scripts/checkNodeVersion.js';
import * as codeReview from './codeReview.js';

const execFileAsync = promisify(execFile);

export const PERSISTENT_MIND_WORKSPACE_PREFLIGHT_SCHEMA_VERSION = 1;
export const PERSISTENT_MIND_WORKSPACE_PREFLIGHT_TTL_MS = 30_000;
export const PERSISTENT_MIND_WORKSPACE_PREFLIGHT_LIMITS = Object.freeze({
  maxApps: 25,
  maxAppIdChars: 128,
  maxAppNameChars: 100,
  maxWorkspaces: 20,
  maxDirectoryEntries: 100,
  maxPackageManifestBytes: 256 * 1024,
  maxScriptNames: 20,
  maxScriptNameChars: 100,
  maxWorkspaceIdChars: 200,
  maxEngineRequirementChars: 200,
  maxGitOutputBytes: 64 * 1024,
  probeTimeoutMs: 5_000,
});

const LOCKFILES = Object.freeze([
  { filename: 'package-lock.json', type: 'npm' },
  { filename: 'npm-shrinkwrap.json', type: 'npm-shrinkwrap' },
  { filename: 'pnpm-lock.yaml', type: 'pnpm' },
  { filename: 'yarn.lock', type: 'yarn' },
  { filename: 'bun.lockb', type: 'bun' },
  { filename: 'bun.lock', type: 'bun' },
]);

const PACKAGE_MANAGER_COMMANDS = Object.freeze({ npm: 'npm', pnpm: 'pnpm', yarn: 'yarn', bun: 'bun' });
const FORGE_COMMANDS = Object.freeze({ github: 'gh', gitlab: 'glab' });
const FORGE_AUTH_ARGS = Object.freeze({
  github: ['auth', 'status'],
  gitlab: ['auth', 'status'],
});
const FORGE_TRACKERS = new Set(['github', 'gitlab']);

const defaultDependencies = {
  readFile,
  readdir,
  opendir,
  stat,
  execGit,
  commandExists,
  execFile: execFileAsync,
  resolveAppForgeTarget,
  getCodeReviewDefaults: (...args) => typeof codeReview.getCodeReviewDefaults === 'function'
    ? codeReview.getCodeReviewDefaults(...args)
    : Promise.resolve(null),
  getReviewerCliInstalled: (...args) => typeof codeReview.getReviewerCliInstalled === 'function'
    ? codeReview.getReviewerCliInstalled(...args)
    : Promise.resolve(null),
};

const cache = new Map();

const isRecord = (value) => value && typeof value === 'object' && !Array.isArray(value);

const nowValue = (clock) => {
  const value = typeof clock === 'function' ? clock() : clock;
  return Number.isFinite(value) ? value : Date.now();
};

const isMissing = (error) => error?.code === 'ENOENT';

const isPathLike = (value) => typeof value === 'string' && (
  isAbsolute(value)
  || /^[A-Za-z]:[\\/]/.test(value)
  || /^~[\\/]/.test(value)
);

const isTimeout = (error) => Boolean(
  error?.code === 'ETIMEDOUT'
  || error?.killed === true
  || error?.signal === 'SIGTERM'
);

const normalizeRelativePath = (value) => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replaceAll('\\', '/');
  if (!normalized || normalized === '.') return '.';
  if (normalized.length > PERSISTENT_MIND_WORKSPACE_PREFLIGHT_LIMITS.maxWorkspaceIdChars) return null;
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || isAbsolute(normalized)) return null;
  const parts = normalized.split('/').filter(Boolean);
  if (parts.some((part) => part === '..' || part === '.')) return null;
  return parts.join('/');
};

const relativeWorkspaceId = (repoPath, workspacePath) => {
  const value = relative(repoPath, workspacePath).replaceAll('\\', '/');
  return (value || 'root').slice(0, PERSISTENT_MIND_WORKSPACE_PREFLIGHT_LIMITS.maxWorkspaceIdChars);
};

const pathForWorkspace = (repoPath, workspaceId) => resolve(repoPath, workspaceId === 'root' ? '.' : workspaceId);

const readPathState = (filePath, dependencies) => dependencies.stat(filePath)
  .then((info) => ({
    state: 'present',
    isDirectory: typeof info?.isDirectory === 'function' ? info.isDirectory() : null,
    size: Number.isFinite(info?.size) ? Number(info.size) : null,
  }))
  .catch((error) => ({ state: isMissing(error) ? 'missing' : 'unknown' }));

const readPackageManifest = (filePath, dependencies) => dependencies.stat(filePath)
  .then((info) => {
    if (Number.isFinite(info?.size) && info.size > PERSISTENT_MIND_WORKSPACE_PREFLIGHT_LIMITS.maxPackageManifestBytes) {
      return { state: 'truncated', value: null };
    }
    return dependencies.readFile(filePath, 'utf8')
      .then((content) => Promise.resolve().then(() => JSON.parse(String(content))))
      .then((value) => ({ state: isRecord(value) ? 'ready' : 'unknown', value: isRecord(value) ? value : null }))
      .catch((error) => ({
        state: isMissing(error) ? 'missing' : 'unknown',
        value: null,
      }));
  })
  .catch((error) => ({ state: isMissing(error) ? 'missing' : 'unknown', value: null }));

const readDirectoryEntries = async (directoryPath, dependencies) => {
  // Keep an injected array reader useful for fixture tests, while the real
  // probe streams directory entries and stops after the safety bound plus one
  // sentinel. `readdir()` materializes an arbitrarily large directory before
  // the slice can be applied.
  if (dependencies.readdir !== readdir) return dependencies.readdir(directoryPath, { withFileTypes: true });
  const directory = await dependencies.opendir(directoryPath);
  const entries = [];
  for await (const entry of directory) {
    entries.push(entry);
    if (entries.length > PERSISTENT_MIND_WORKSPACE_PREFLIGHT_LIMITS.maxDirectoryEntries) break;
  }
  return entries;
};

const readDirectoryNames = (directoryPath, dependencies) => Promise.resolve()
  .then(() => readDirectoryEntries(directoryPath, dependencies))
  .then((entries) => {
    const bounded = Array.isArray(entries) ? entries.slice(0, PERSISTENT_MIND_WORKSPACE_PREFLIGHT_LIMITS.maxDirectoryEntries) : [];
    return {
      names: bounded
        .filter((entry) => typeof entry?.name === 'string' && (typeof entry.isDirectory !== 'function' || entry.isDirectory()))
        .map((entry) => entry.name)
        .sort(),
      truncated: Array.isArray(entries) && entries.length > bounded.length,
      unknown: false,
    };
  })
  .catch(() => ({ names: [], truncated: false, unknown: true }));

const workspacePatterns = (manifest) => {
  const raw = manifest?.workspaces;
  if (Array.isArray(raw)) return raw;
  if (isRecord(raw) && Array.isArray(raw.packages)) return raw.packages;
  return [];
};

const safeEngineRequirement = (value) => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = value.trim();
  return /^[vV0-9xX*<>=~^|.,\s-]+$/.test(normalized)
    ? normalized.slice(0, PERSISTENT_MIND_WORKSPACE_PREFLIGHT_LIMITS.maxEngineRequirementChars)
    : 'unknown';
};

const expandWorkspacePattern = (repoPath, pattern, dependencies) => {
  const normalized = normalizeRelativePath(pattern);
  if (!normalized) return Promise.resolve({ paths: [], truncated: true });
  const segments = normalized.split('/');
  const hasGlob = segments.some((segment) => segment === '*');
  if (!hasGlob) return Promise.resolve({ paths: [pathForWorkspace(repoPath, normalized)], truncated: false });
  if (segments.some((segment) => segment !== '*' && /[*?\[\]]/.test(segment))) {
    return Promise.resolve({ paths: [], truncated: true });
  }

  const walk = async (basePath, index) => {
    if (index >= segments.length) return { paths: [basePath], truncated: false, unknown: false };
    const segment = segments[index];
    if (segment !== '*') return walk(join(basePath, segment), index + 1);
    const { names, truncated: listingTruncated, unknown: listingUnknown } = await readDirectoryNames(basePath, dependencies);
    const paths = [];
    let truncated = listingTruncated;
    let unknown = listingUnknown;
    for (const name of names) {
      if (paths.length >= PERSISTENT_MIND_WORKSPACE_PREFLIGHT_LIMITS.maxWorkspaces) {
        truncated = true;
        break;
      }
      const result = await walk(join(basePath, name), index + 1);
      paths.push(...result.paths.slice(0, PERSISTENT_MIND_WORKSPACE_PREFLIGHT_LIMITS.maxWorkspaces - paths.length));
      truncated ||= result.truncated;
      unknown ||= result.unknown;
      if (paths.length >= PERSISTENT_MIND_WORKSPACE_PREFLIGHT_LIMITS.maxWorkspaces) truncated = true;
    }
    return { paths, truncated, unknown };
  };

  return walk(repoPath, 0);
};

const discoverWorkspacePaths = async (repoPath, manifest, dependencies) => {
  const patterns = workspacePatterns(manifest);
  if (!patterns.length) return { paths: [repoPath], truncated: false };
  const expanded = await Promise.all(patterns.slice(0, PERSISTENT_MIND_WORKSPACE_PREFLIGHT_LIMITS.maxWorkspaces).map(
    (pattern) => expandWorkspacePattern(repoPath, pattern, dependencies)
  ));
  const paths = [repoPath, ...expanded.flatMap((item) => item.paths || [])];
  const unique = [...new Set(paths)].slice(0, PERSISTENT_MIND_WORKSPACE_PREFLIGHT_LIMITS.maxWorkspaces);
  return {
    paths: unique,
    truncated: patterns.length > PERSISTENT_MIND_WORKSPACE_PREFLIGHT_LIMITS.maxWorkspaces
      || expanded.some((item) => item.truncated)
      || paths.length > unique.length,
    unknown: expanded.some((item) => item.unknown),
  };
};

const scriptNames = (manifest) => {
  const scripts = isRecord(manifest?.scripts) ? Object.keys(manifest.scripts) : [];
  const pick = (prefix) => scripts
    .filter((name) => name === prefix || name.startsWith(`${prefix}:`) || name.startsWith(`${prefix}-`))
    .sort()
    .slice(0, PERSISTENT_MIND_WORKSPACE_PREFLIGHT_LIMITS.maxScriptNames);
  const bound = (names) => names.map((name) => name.slice(0, PERSISTENT_MIND_WORKSPACE_PREFLIGHT_LIMITS.maxScriptNameChars));
  return { test: bound(pick('test')), build: bound(pick('build')) };
};

const engineRequirements = (manifest) => {
  const engines = isRecord(manifest?.engines) ? manifest.engines : {};
  const manager = Object.keys(PACKAGE_MANAGER_COMMANDS).find((name) => typeof engines[name] === 'string' && engines[name].trim());
  const packageManager = typeof manifest?.packageManager === 'string'
    ? manifest.packageManager.trim().match(/^([a-z]+)@(.+)$/i)
    : null;
  const packageManagerName = packageManager && PACKAGE_MANAGER_COMMANDS[packageManager[1].toLowerCase()]
    ? packageManager[1].toLowerCase()
    : manager || null;
  const packageManagerRequirement = packageManagerName
    ? (safeEngineRequirement(engines[packageManagerName])
      || (packageManager?.[2] ? /^v?\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?$/.test(packageManager[2].trim())
        ? `=${packageManager[2].trim().slice(0, PERSISTENT_MIND_WORKSPACE_PREFLIGHT_LIMITS.maxEngineRequirementChars - 1)}`
        : 'unknown' : null))
    : null;
  return {
    node: safeEngineRequirement(engines.node),
    packageManager: packageManagerName ? {
      name: packageManagerName,
      required: packageManagerRequirement,
    } : null,
  };
};

/**
 * Compare a tool version against the small, portable subset of npm engine
 * ranges used by PortOS manifests. It intentionally does not pretend to be a
 * complete semver implementation; unsupported syntax is unknown to callers.
 */
export function satisfiesVersionRequirement(version, requirement) {
  if (typeof version !== 'string' || !version.trim() || typeof requirement !== 'string' || !requirement.trim()) return null;
  if (!/^v?\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?$/.test(version.trim())) return null;
  const alternatives = requirement.split('||').map((part) => part.trim()).filter(Boolean);
  if (!alternatives.length) return null;

  const satisfiesComparator = (candidate, comparator) => {
    const token = comparator.trim();
    if (!token || token === '*' || /^x$/i.test(token)) return true;
    const match = token.match(/^(>=|<=|>|<|=|\^|~)?\s*(v?\d+(?:\.\d+){0,2})(?:\.[xX*])?$/);
    if (!match) return null;
    const operator = match[1] || '=';
    const target = match[2];
    const comparison = compareVersions(candidate, target);
    const numericParts = target.replace(/^v/, '').split('.').map((part) => Number(part));
    const major = numericParts[0];
    const minor = numericParts[1] || 0;
    const patch = numericParts[2] || 0;
    const isPartial = numericParts.length < 3 || /(?:^|\.)[xX*]$/.test(token);
    const partialUpper = numericParts.length < 2
      ? `${major + 1}.0.0`
      : `${major}.${minor + 1}.0`;
    if (operator === '=' && isPartial) {
      return comparison >= 0 && compareVersions(candidate, partialUpper) < 0;
    }
    if (operator === '>=') return comparison >= 0;
    if (operator === '<=') return isPartial
      ? compareVersions(candidate, partialUpper) < 0
      : comparison <= 0;
    if (operator === '>') return isPartial
      ? compareVersions(candidate, partialUpper) >= 0
      : comparison > 0;
    if (operator === '<') return comparison < 0;
    if (operator === '^') {
      const upper = major > 0
        ? `${major + 1}.0.0`
        : minor > 0
          ? `0.${minor + 1}.0`
          : numericParts.length < 3 ? '0.1.0' : `0.0.${patch + 1}`;
      return comparison >= 0 && compareVersions(candidate, upper) < 0;
    }
    if (operator === '=') return comparison === 0;
    const upper = numericParts.length < 2 ? `${major + 1}.0.0` : `${major}.${minor + 1}.0`;
    return comparison >= 0 && compareVersions(candidate, upper) < 0;
  };

  const results = alternatives.map((alternative) => {
    const comparators = alternative.replaceAll(',', ' ').split(/\s+/).filter(Boolean);
    const values = comparators.map((comparator) => satisfiesComparator(version, comparator));
    if (values.some((value) => value === null)) return null;
    return values.every(Boolean);
  });
  if (results.some(Boolean)) return true;
  if (results.every((value) => value === false)) return false;
  return null;
}

const normalizeVersion = (value) => {
  const match = String(value || '').trim().match(/^v?\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?$/);
  return match ? match[0].replace(/^v/, '') : null;
};

const actualVersion = (output) => {
  const match = String(output || '').match(/\bv?\d+(?:\.\d+){1,2}(?:-[0-9A-Za-z.-]+)?\b/);
  return normalizeVersion(match?.[0]);
};

const compatibility = (actual, required) => {
  const normalizedActual = normalizeVersion(actual);
  if (!required) return { required: null, actual: normalizedActual, status: 'not-declared' };
  const result = satisfiesVersionRequirement(normalizedActual, required);
  return {
    required,
    actual: normalizedActual,
    status: result === true ? 'compatible' : result === false ? 'incompatible' : 'unknown',
  };
};

const safeGit = (args, cwd, dependencies) => dependencies.execGit(args, cwd, {
  ignoreExitCode: true,
  maxBuffer: PERSISTENT_MIND_WORKSPACE_PREFLIGHT_LIMITS.maxGitOutputBytes,
  timeout: PERSISTENT_MIND_WORKSPACE_PREFLIGHT_LIMITS.probeTimeoutMs,
}).then((result) => result).catch(() => null);

const inspectRepository = async (app, dependencies) => {
  const repoPath = typeof app?.repoPath === 'string' ? app.repoPath.trim() : '';
  if (!repoPath) {
    return {
      repository: { configured: false, reachable: false },
      checkout: { state: 'unknown' },
    };
  }
  const pathState = await readPathState(repoPath, dependencies);
  if (pathState.state === 'missing' || pathState.isDirectory === false) {
    return {
      repository: { configured: true, reachable: false },
      checkout: { state: 'unknown' },
    };
  }
  if (pathState.state !== 'present') {
    return {
      repository: { configured: true, reachable: null },
      checkout: { state: 'unknown' },
    };
  }
  const reachableProbe = await safeGit(['rev-parse', '--is-inside-work-tree'], repoPath, dependencies);
  if (!reachableProbe) {
    return {
      repository: { configured: true, reachable: null },
      checkout: { state: 'unknown' },
    };
  }
  if (reachableProbe.exitCode !== 0 || String(reachableProbe.stdout || '').trim() !== 'true') {
    return {
      repository: { configured: true, reachable: false },
      checkout: { state: 'unknown' },
    };
  }
  const statusProbe = await safeGit(['status', '--porcelain', '--untracked-files=all'], repoPath, dependencies);
  return {
    repository: { configured: true, reachable: true },
    checkout: {
      state: statusProbe && statusProbe.exitCode === 0
        ? String(statusProbe.stdout || '').trim() ? 'dirty' : 'clean'
        : 'unknown',
    },
  };
};

const inspectLockfile = async (workspacePath, repoPath, dependencies) => {
  const localChecks = await Promise.all(LOCKFILES.map(async (candidate) => ({
    ...candidate,
    result: await readPathState(join(workspacePath, candidate.filename), dependencies),
  })));
  const localPresent = localChecks.find((candidate) => candidate.result.state === 'present');
  if (localPresent) return { status: 'present', type: localPresent.type, scope: 'workspace' };
  if (localChecks.some((candidate) => candidate.result.state === 'unknown')) {
    return { status: 'unknown', type: null, scope: null };
  }
  if (workspacePath === repoPath) return { status: 'absent', type: null, scope: null };
  const rootChecks = await Promise.all(LOCKFILES.map(async (candidate) => ({
    ...candidate,
    result: await readPathState(join(repoPath, candidate.filename), dependencies),
  })));
  const rootPresent = rootChecks.find((candidate) => candidate.result.state === 'present');
  if (rootPresent) return { status: 'present', type: rootPresent.type, scope: 'root' };
  if (rootChecks.some((candidate) => candidate.result.state === 'unknown')) {
    return { status: 'unknown', type: null, scope: null };
  }
  return { status: 'absent', type: null, scope: null };
};

const inspectDependencies = async (workspacePath, repoPath, dependencies) => {
  const local = await readPathState(join(workspacePath, 'node_modules'), dependencies);
  if (local.state === 'present' && local.isDirectory !== false) return { status: 'installed', source: 'workspace' };
  if (local.state === 'unknown') return { status: 'unknown', source: null };
  if (workspacePath === repoPath) return { status: 'absent', source: null };
  const root = await readPathState(join(repoPath, 'node_modules'), dependencies);
  if (root.state === 'present' && root.isDirectory !== false) return { status: 'installed', source: 'root' };
  if (root.state === 'unknown') return { status: 'unknown', source: null };
  return { status: 'absent', source: null };
};

const readManagerVersions = async (names, repoPath, dependencies, runtime) => {
  const configured = isRecord(runtime?.packageManagerVersions) ? runtime.packageManagerVersions : {};
  const entries = await Promise.all([...names].map(async (name) => {
    if (typeof configured[name] === 'string' && configured[name].trim()) return [name, actualVersion(configured[name])];
    const command = PACKAGE_MANAGER_COMMANDS[name];
    if (!command) return [name, null];
    const result = await dependencies.execFile(command, ['--version'], {
      cwd: repoPath,
      env: withSpawnCwdEnv(process.env, repoPath),
      timeout: PERSISTENT_MIND_WORKSPACE_PREFLIGHT_LIMITS.probeTimeoutMs,
      maxBuffer: 4 * 1024,
    }).catch(() => null);
    return [name, result ? actualVersion(result.stdout ?? result) : null];
  }));
  return Object.fromEntries(entries);
};

const inspectSubmodules = async (repoPath, dependencies) => {
  const gitmodules = await readPathState(join(repoPath, '.gitmodules'), dependencies);
  if (gitmodules.state === 'missing') return { configured: false, status: 'not-configured', initialized: null };
  if (gitmodules.state !== 'present') return { configured: null, status: 'unknown', initialized: null };
  const result = await safeGit(['submodule', 'status', '--recursive'], repoPath, dependencies);
  if (!result || result.exitCode !== 0) return { configured: true, status: 'unknown', initialized: null };
  const lines = String(result.stdout || '').split(/\r?\n/).filter(Boolean);
  const uninitialized = lines.some((line) => line.startsWith('-'));
  return {
    configured: true,
    status: uninitialized ? 'uninitialized' : 'initialized',
    initialized: !uninitialized,
  };
};

const inspectForge = async (app, repository, dependencies) => {
  const resolution = await dependencies.resolveAppForgeTarget(app).catch(() => null);
  const target = resolution?.target;
  const tracker = resolution?.tracker;
  const forge = target?.forge || (FORGE_TRACKERS.has(tracker) ? tracker : null);
  if (!forge) {
    return { provider: 'none', cli: null, installed: null, authenticated: null, status: 'not-configured' };
  }
  if (!FORGE_COMMANDS[forge]) {
    return { provider: 'unknown', cli: null, installed: null, authenticated: null, status: 'unknown' };
  }
  if (repository.reachable !== true) {
    return { provider: forge, cli: FORGE_COMMANDS[forge], installed: null, authenticated: null, status: 'unknown' };
  }
  const cli = FORGE_COMMANDS[forge];
  const installed = await dependencies.commandExists(cli, ['--version'], {
    cwd: typeof app.repoPath === 'string' ? app.repoPath : undefined,
    timeoutMs: PERSISTENT_MIND_WORKSPACE_PREFLIGHT_LIMITS.probeTimeoutMs,
  }).catch(() => false);
  if (!installed) return { provider: forge, cli, installed: false, authenticated: false, status: 'unavailable' };
  const authArgs = target?.apiHost
    ? [...FORGE_AUTH_ARGS[forge], '--hostname', target.apiHost]
    : FORGE_AUTH_ARGS[forge];
  const authResult = await dependencies.execFile(cli, authArgs, {
    cwd: app.repoPath,
    env: withSpawnCwdEnv(process.env, app.repoPath),
    timeout: PERSISTENT_MIND_WORKSPACE_PREFLIGHT_LIMITS.probeTimeoutMs,
    maxBuffer: 8 * 1024,
  }).then(() => true).catch((error) => isTimeout(error) ? null : false);
  return {
    provider: forge,
    cli,
    installed: true,
    authenticated: authResult,
    status: authResult === true ? 'ready' : authResult === false ? 'unavailable' : 'unknown',
  };
};

const reviewerAvailability = (reviewer, forge, installed) => {
  if (isCliReviewer(reviewer)) return installed && Object.hasOwn(installed, reviewer) ? installed[reviewer] : null;
  if (reviewer === 'copilot') {
    if (forge?.provider !== 'github') return false;
    return forge.authenticated === true ? true : forge.authenticated === false ? false : null;
  }
  return null;
};

const emptyReviewerSummary = (status = 'unknown') => ({
  configured: 0,
  available: 0,
  unavailable: 0,
  unknown: 0,
  status,
});

const summarizeReviewers = (entries) => {
  const summary = emptyReviewerSummary(entries.length ? 'unknown' : 'not-configured');
  summary.configured = entries.length;
  if (!entries.length) return summary;
  entries.forEach((entry) => {
    if (entry.available === true) summary.available += 1;
    else if (entry.available === false) summary.unavailable += 1;
    else summary.unknown += 1;
  });
  summary.status = summary.unavailable > 0 ? 'unavailable' : summary.unknown > 0 ? 'unknown' : 'ready';
  return summary;
};

const reviewerProbeFor = (dependencies) => {
  let promise;
  return () => {
    if (!promise) {
      promise = Promise.all([
        dependencies.getCodeReviewDefaults().catch(() => null),
        dependencies.getReviewerCliInstalled().catch(() => null),
      ]);
    }
    return promise;
  };
};

const inspectReviewers = async (forge, dependencies, reviewerProbe = reviewerProbeFor(dependencies)) => {
  const [defaults, installed] = await reviewerProbe();
  if (!defaults) {
    return {
      configured: null,
      required: emptyReviewerSummary(),
      optional: emptyReviewerSummary(),
      status: 'unknown',
    };
  }
  const fixedReviewers = Array.isArray(defaults.reviewers) ? defaults.reviewers.filter((value) => REVIEWER_VALUES.includes(value)) : [];
  const usernames = Array.isArray(defaults.usernames) ? defaults.usernames.filter((value) => typeof value === 'string' && value.trim()) : [];
  const optional = new Set(Array.isArray(defaults.optionalReviewers) ? defaults.optionalReviewers : []);
  const requiredEntries = fixedReviewers
    .filter((reviewer) => !optional.has(reviewer))
    .map((reviewer) => ({ available: reviewerAvailability(reviewer, forge, installed) }));
  const optionalEntries = fixedReviewers
    .filter((reviewer) => optional.has(reviewer))
    .map((reviewer) => ({ available: reviewerAvailability(reviewer, forge, installed) }));
  const usernameAvailability = forge?.authenticated === true ? true : forge?.authenticated === false ? false : null;
  usernames.forEach((username) => {
    const identity = `@${username.replace(/^@/, '')}`;
    const entry = { available: usernameAvailability };
    if (optional.has(identity)) optionalEntries.push(entry);
    else requiredEntries.push(entry);
  });
  const required = summarizeReviewers(requiredEntries);
  const optionalSummary = summarizeReviewers(optionalEntries);
  return {
    configured: required.configured + optionalSummary.configured,
    required,
    optional: optionalSummary,
    status: required.status === 'unavailable'
      ? 'unavailable'
      : required.status === 'unknown'
        ? 'unknown'
        : optionalSummary.status === 'unavailable' || optionalSummary.status === 'unknown' ? 'degraded' : 'ready',
  };
};

const engineStatus = (workspaces) => workspaces.flatMap((workspace) => [
  workspace.engines?.node?.status,
  workspace.engines?.packageManager?.status,
]).filter(Boolean);

const dependencyStatus = (workspaces) => workspaces.map((workspace) => workspace.dependencies?.status).filter(Boolean);

const checkStatus = (preflight, check) => {
  if (check === 'dependencies') {
    const statuses = dependencyStatus(Array.isArray(preflight?.workspaces) ? preflight.workspaces : []);
    if (preflight?.workspaceDiscovery !== 'ready' || !statuses.length) return 'unknown';
    return statuses.some((status) => status === 'unknown') ? 'unknown' : statuses.some((status) => status !== 'installed') ? 'unavailable' : 'ready';
  }
  if (check === 'engines') {
    const statuses = engineStatus(Array.isArray(preflight?.workspaces) ? preflight.workspaces : []).filter((status) => status !== 'not-declared');
    if (preflight?.workspaceDiscovery !== 'ready' || !Array.isArray(preflight?.workspaces) || !preflight.workspaces.every((workspace) => workspace.manifest === 'ready')) return 'unknown';
    return statuses.some((status) => status === 'unknown') ? 'unknown' : statuses.some((status) => status === 'incompatible') ? 'unavailable' : 'ready';
  }
  if (check === 'submodules') {
    if (preflight?.submodules?.status === 'not-configured') return 'ready';
    return preflight?.submodules?.status === 'initialized' ? 'ready' : preflight?.submodules?.status === 'uninitialized' ? 'unavailable' : 'unknown';
  }
  if (check === 'forge') return ['ready', 'not-configured'].includes(preflight?.forge?.status) ? 'ready' : preflight?.forge?.status === 'unavailable' ? 'unavailable' : 'unknown';
  if (check === 'reviewers') return ['ready', 'not-configured'].includes(preflight?.reviewers?.required?.status) ? 'ready' : preflight?.reviewers?.required?.status === 'unavailable' ? 'unavailable' : 'unknown';
  return 'unknown';
};

const CHECK_MESSAGES = Object.freeze({
  dependencies: 'Dependencies are absent or could not be verified for a declared workspace.',
  engines: 'The required Node.js or package-manager engine is incompatible or could not be verified.',
  submodules: 'One or more configured submodules are not initialized or could not be verified.',
  forge: 'The configured forge CLI is unavailable or is not authenticated.',
  reviewers: 'One or more required reviewers are unavailable or could not be verified.',
});

const buildWarnings = (preflight) => {
  const warnings = [];
  if (preflight.checkout?.state === 'dirty') {
    warnings.push({
      code: 'workspace-checkout-dirty',
      check: 'checkout',
      severity: 'advisory',
      message: 'The workspace has local changes; delegated work should preserve them.',
    });
  }
  PERSISTENT_MIND_VALIDATION_CHECKS.forEach((check) => {
    const status = checkStatus(preflight, check);
    if (status !== 'ready') warnings.push({ code: `workspace-${check}-${status}`, check, severity: 'warning', message: CHECK_MESSAGES[check] });
  });
  if (preflight.reviewers.optional.status === 'unavailable' || preflight.reviewers.optional.status === 'unknown') {
    warnings.push({
      code: `workspace-reviewers-optional-${preflight.reviewers.optional.status}`,
      check: 'reviewers',
      severity: 'advisory',
      message: 'Optional reviewers are unavailable or could not be verified; they do not block the task.',
    });
  }
  if (preflight.truncated) warnings.push({ code: 'workspace-preflight-truncated', check: 'preflight', severity: 'advisory', message: 'Workspace preflight reached a safety bound; some facts may be unknown.' });
  return warnings;
};

const readinessForSnapshot = (repository, checkout, workspaces, submodules, forge, reviewers) => {
  if (repository.reachable === false) return 'blocked';
  if (workspaces.some((workspace) => workspace.manifest !== 'ready')) return 'unknown';
  const engines = engineStatus(workspaces);
  if (engines.includes('incompatible')) return 'blocked';
  if (repository.reachable === null || checkout.state === 'unknown' || engines.includes('unknown')) return 'unknown';
  const degraded = checkout.state === 'dirty'
    || dependencyStatus(workspaces).some((status) => status !== 'installed')
    || submodules.status === 'uninitialized'
    || submodules.status === 'unknown'
    || forge.status === 'unavailable'
    || forge.status === 'unknown'
    || ['unavailable', 'unknown'].includes(reviewers.required.status)
    || ['unavailable', 'unknown'].includes(reviewers.optional.status);
  return degraded ? 'degraded' : 'ready';
};

const unknownSnapshot = (app, capturedAt) => ({
  schemaVersion: PERSISTENT_MIND_WORKSPACE_PREFLIGHT_SCHEMA_VERSION,
  capturedAt,
  freshness: { state: 'fresh', capturedAt, ageMs: 0, ttlMs: PERSISTENT_MIND_WORKSPACE_PREFLIGHT_TTL_MS },
  truncated: false,
  workspaceDiscovery: 'unknown',
  readiness: 'unknown',
  repository: { configured: Boolean(typeof app?.repoPath === 'string' && app.repoPath.trim()), reachable: null },
  checkout: { state: 'unknown' },
  workspaces: [],
  submodules: { configured: null, status: 'unknown', initialized: null },
  forge: { provider: 'unknown', cli: null, installed: null, authenticated: null, status: 'unknown' },
  reviewers: { configured: null, required: emptyReviewerSummary(), optional: emptyReviewerSummary(), status: 'unknown' },
  warnings: [{ code: 'workspace-preflight-unknown', check: 'preflight', severity: 'warning', message: 'Workspace readiness could not be verified.' }],
});

const collectPreflight = async (app, options) => {
  const dependencies = { ...defaultDependencies, ...(options.dependencies || {}) };
  const reviewerProbe = options.reviewerProbe || reviewerProbeFor(dependencies);
  const timestamp = nowValue(options.now);
  const capturedAt = new Date(timestamp).toISOString();
  const repoPath = typeof app?.repoPath === 'string' ? app.repoPath.trim() : '';
  const normalizedApp = repoPath ? { ...app, repoPath } : app;
  const repository = await inspectRepository(normalizedApp, dependencies);
  if (repository.repository.reachable !== true) {
    const submodules = { configured: null, status: 'unknown', initialized: null };
    const forge = await inspectForge(normalizedApp, repository.repository, dependencies);
    const reviewers = await inspectReviewers(forge, dependencies, reviewerProbe);
    const snapshot = {
      schemaVersion: PERSISTENT_MIND_WORKSPACE_PREFLIGHT_SCHEMA_VERSION,
      capturedAt,
      freshness: { state: 'fresh', capturedAt, ageMs: 0, ttlMs: PERSISTENT_MIND_WORKSPACE_PREFLIGHT_TTL_MS },
      truncated: false,
      workspaceDiscovery: 'unknown',
      readiness: repository.repository.reachable === false ? 'blocked' : 'unknown',
      repository: repository.repository,
      checkout: repository.checkout,
      workspaces: [],
      submodules,
      forge,
      reviewers,
      warnings: [],
    };
    snapshot.warnings = buildWarnings(snapshot);
    return snapshot;
  }

  const rootManifest = await readPackageManifest(join(repoPath, 'package.json'), dependencies);
  const discovered = await discoverWorkspacePaths(repoPath, rootManifest.value, dependencies);
  const workspacePaths = discovered.paths.slice(0, PERSISTENT_MIND_WORKSPACE_PREFLIGHT_LIMITS.maxWorkspaces);
  const managerNames = new Set();
  const manifests = await Promise.all(workspacePaths.map((workspacePath) => (
    workspacePath === repoPath ? Promise.resolve(rootManifest) : readPackageManifest(join(workspacePath, 'package.json'), dependencies)
  )));
  const workspaceFacts = manifests.map((manifest, index) => {
    const workspacePath = workspacePaths[index];
    const requirements = engineRequirements(manifest.value);
    if (requirements.packageManager?.name) managerNames.add(requirements.packageManager.name);
    return { workspacePath, manifest, requirements };
  });
  const managerVersions = await readManagerVersions(managerNames, repoPath, dependencies, options.runtime || {});
  const nodeVersion = options.runtime?.nodeVersion || process.versions.node || null;
  const workspaces = await Promise.all(workspaceFacts.map(async ({ workspacePath, manifest, requirements }) => {
    const manager = requirements.packageManager;
    return {
      id: relativeWorkspaceId(repoPath, workspacePath),
      manifest: manifest.state,
      lockfile: await inspectLockfile(workspacePath, repoPath, dependencies),
      dependencies: await inspectDependencies(workspacePath, repoPath, dependencies),
      engines: {
        node: compatibility(nodeVersion, requirements.node),
        packageManager: manager ? {
          name: manager.name,
          ...compatibility(managerVersions[manager.name], manager.required),
        } : null,
      },
      scripts: scriptNames(manifest.value),
    };
  }));
  const submodules = await inspectSubmodules(repoPath, dependencies);
  const forge = await inspectForge(normalizedApp, repository.repository, dependencies);
  const reviewers = await inspectReviewers(forge, dependencies, reviewerProbe);
  const snapshot = {
    schemaVersion: PERSISTENT_MIND_WORKSPACE_PREFLIGHT_SCHEMA_VERSION,
    capturedAt,
    freshness: { state: 'fresh', capturedAt, ageMs: 0, ttlMs: PERSISTENT_MIND_WORKSPACE_PREFLIGHT_TTL_MS },
    truncated: discovered.truncated || workspaceFacts.some(({ manifest }) => manifest.state === 'truncated'),
    workspaceDiscovery: discovered.unknown ? 'unknown' : discovered.truncated ? 'truncated' : 'ready',
    readiness: null,
    repository: repository.repository,
    checkout: repository.checkout,
    workspaces,
    submodules,
    forge,
    reviewers,
    warnings: [],
  };
  snapshot.readiness = discovered.unknown || discovered.truncated
    ? 'unknown'
    : readinessForSnapshot(repository.repository, repository.checkout, workspaces, submodules, forge, reviewers);
  snapshot.warnings = buildWarnings(snapshot);
  return snapshot;
};

const cacheKeyFor = (app) => `${app?.id || ''}\0${app?.repoPath || ''}\0${app?.workTracker || 'auto'}`;

const withFreshness = (snapshot, timestamp) => {
  const captured = Date.parse(snapshot.capturedAt);
  const ageMs = Number.isFinite(captured) ? Math.max(0, timestamp - captured) : null;
  return {
    ...snapshot,
    freshness: {
      state: ageMs !== null && ageMs <= PERSISTENT_MIND_WORKSPACE_PREFLIGHT_TTL_MS ? 'fresh' : 'stale',
      capturedAt: snapshot.capturedAt,
      ageMs,
      ttlMs: PERSISTENT_MIND_WORKSPACE_PREFLIGHT_TTL_MS,
    },
  };
};

/** Clear the process-local cache; intended for tests and explicit diagnostics. */
export function resetPersistentMindWorkspacePreflightCache() {
  cache.clear();
}

/**
 * Inspect one configured app. A repeated read within the freshness window does
 * not re-run git, filesystem, forge, or reviewer probes.
 */
export function readPersistentMindWorkspacePreflight(app, {
  force = false,
  now = Date.now,
  dependencies,
  runtime,
  reviewerProbe,
} = {}) {
  const timestamp = nowValue(now);
  const key = cacheKeyFor(app);
  const cached = cache.get(key);
  if (!force && cached && cached.expiresAt > timestamp) {
    return cached.promise.then((snapshot) => withFreshness(snapshot, timestamp));
  }
  const promise = collectPreflight(app, { now: timestamp, dependencies, runtime, reviewerProbe })
    .catch(() => unknownSnapshot(app, new Date(timestamp).toISOString()));
  cache.set(key, { promise, expiresAt: timestamp + PERSISTENT_MIND_WORKSPACE_PREFLIGHT_TTL_MS });
  return promise.then((snapshot) => withFreshness(snapshot, timestamp));
}

/** Read a bounded set of app preflights, retaining app identity but no paths. */
export async function readPersistentMindWorkspacePreflights(apps, options = {}) {
  const candidates = (Array.isArray(apps) ? apps : [])
    .filter((app) => typeof app?.id === 'string' && app.id.trim()
      && !isPathLike(app.id.trim())
      && app.id.length <= PERSISTENT_MIND_WORKSPACE_PREFLIGHT_LIMITS.maxAppIdChars)
    .slice(0, PERSISTENT_MIND_WORKSPACE_PREFLIGHT_LIMITS.maxApps);
  const dependencies = { ...defaultDependencies, ...(options.dependencies || {}) };
  const reviewerProbe = reviewerProbeFor(dependencies);
  return Promise.all(candidates.map(async (app) => ({
    appId: app.id.trim(),
    appName: typeof app.name === 'string' && app.name.trim() && !isPathLike(app.name.trim())
      ? app.name.trim().slice(0, PERSISTENT_MIND_WORKSPACE_PREFLIGHT_LIMITS.maxAppNameChars)
      : app.id.trim(),
    preflight: await readPersistentMindWorkspacePreflight(app, {
      ...options,
      dependencies,
      reviewerProbe,
    }),
  })));
}

/**
 * Apply task-declared validation requirements to a cached preflight. Missing
 * dependencies remain advisory for tasks that do not declare them, so a
 * docs-only/read-only task is not incorrectly blocked.
 */
export function assessPersistentMindWorkspaceReadiness(preflight, requiredValidation = []) {
  const required = [...new Set((Array.isArray(requiredValidation) ? requiredValidation : [])
    .filter((check) => PERSISTENT_MIND_VALIDATION_CHECKS.includes(check)))];
  const blockers = required
    .map((check) => ({ check, status: checkStatus(preflight || {}, check) }))
    .filter(({ status }) => status !== 'ready')
    .map(({ check, status }) => ({
      code: `workspace-${check}-${status}`,
      check,
      status,
      message: CHECK_MESSAGES[check],
    }));
  const readiness = blockers.length > 0
    ? 'blocked'
    : preflight?.readiness || 'unknown';
  return {
    readiness,
    requiredValidation: required,
    blockers,
    warnings: Array.isArray(preflight?.warnings) ? preflight.warnings : [],
  };
}

export const PERSISTENT_MIND_WORKSPACE_PREFLIGHT_CHECKS = PERSISTENT_MIND_VALIDATION_CHECKS;
