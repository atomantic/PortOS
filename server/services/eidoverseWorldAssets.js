/** Local runtime protocol preflight, library verification, and persisted asset locks. */

import { buildEidoverseCitySurface } from '../lib/eidoverseCitySurface.js';
import { eidoverseModelBounds } from '../lib/eidoverseCityLayout.js';
import {
  EIDOVERSE_ASSET_RECIPE_VERSION,
  EIDOVERSE_WORLD_DESIGN_VERSION,
  inspectEidoverseAssetResolutionLocks,
  isValidEidoverseAssetOverridePath,
  resolveEidoverseAssetRecipe,
  resolveEidoverseDesign,
} from '../lib/eidoverseWorldDesign.js';
import { eidoverseLabelCapabilities } from '../lib/eidoverseWorldLabels.js';
import { ServerError } from '../lib/errorHandler.js';
import { canonicalStringify } from '../lib/objects.js';
import { getCosPresence, resolveWorldWsUrl, throwIfAborted, waitWithSignal } from './eidoverseWorldConnection.js';
import { DEFAULT_EIDOVERSE_PROJECTION_RECIPE } from './eidoverseWorldProjection.js';
import { configFromState, mutateState, safeText } from './eidoverseWorldState.js';

function resolveWorldHttpUrl() {
  const configured = typeof process.env.EIDOVERSE_HTTP_URL === 'string' ? process.env.EIDOVERSE_HTTP_URL.trim() : '';
  if (configured) return configured;
  const url = new URL(resolveWorldWsUrl());
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url.toString();
}

export const libraryUrl = (path, query = null) => {
  const url = new URL(path, resolveWorldHttpUrl());
  for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, value);
  return url;
};

async function fetchLibraryJson(path, query, { signal } = {}) {
  const response = await waitWithSignal(fetch(libraryUrl(path, query), { signal }), signal).catch((error) => {
    throw new ServerError(`Eidoverse asset library is unavailable: ${error.message}`, {
      status: 503,
      code: 'EIDOVERSE_ASSET_LIBRARY_UNAVAILABLE',
    });
  });
  if (!response.ok) {
    throw new ServerError(`Eidoverse asset library returned HTTP ${response.status}.`, {
      status: 503,
      code: 'EIDOVERSE_ASSET_LIBRARY_UNAVAILABLE',
    });
  }
  return response.json();
}

async function preflightEidoverseProtocol({ signal } = {}) {
  const response = await waitWithSignal(fetch(libraryUrl('/version'), { signal }), signal).catch((error) => {
    throw new ServerError(`Eidoverse Worlds is not reachable yet: ${error.message}`, {
      status: 503,
      code: 'EIDOVERSE_WORLD_UNAVAILABLE',
    });
  });
  if (response.status >= 500) {
    throw new ServerError(`Eidoverse Worlds is temporarily unavailable (HTTP ${response.status}). Retry after its managed runtime finishes starting.`, {
      status: 503,
      code: 'EIDOVERSE_WORLD_UNAVAILABLE',
    });
  }
  if (!response.ok) {
    throw new ServerError('This Eidoverse Worlds runtime is too old for PortOS World Design V2. Update its managed app from Apps, then retry.', {
      status: 409,
      code: 'EIDOVERSE_PROTOCOL_INCOMPATIBLE',
      context: { remediation: '/apps', required: 'world-design-v2' },
    });
  }
  const version = await response.json().catch(() => null);
  if (!version || typeof version.sha !== 'string' || typeof version.commitTime !== 'string') {
    throw new ServerError('Eidoverse Worlds did not report the protocol build identity required by PortOS World Design V2. Update its managed app from Apps, then retry.', {
      status: 409,
      code: 'EIDOVERSE_PROTOCOL_INCOMPATIBLE',
      context: { remediation: '/apps', required: 'world-design-v2' },
    });
  }
  return {
    capabilities: { ...eidoverseLabelCapabilities(version),
      largeWorldColliders: version.capabilities?.largeWorldColliders === 1 ? 1 : null },
    sha: safeText(version.sha, 'unknown', 80),
    commitTime: safeText(version.commitTime, 'unknown', 80),
  };
}

async function verifyLibraryAsset(path, { signal } = {}) {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  const response = await waitWithSignal(fetch(libraryUrl(`/library/${encoded}`), {
    method: 'HEAD',
    signal,
  }), signal).catch((error) => {
    throw new ServerError(`Eidoverse could not verify ${path}: ${error.message}`, {
      status: 409,
      code: 'EIDOVERSE_ASSET_PREFLIGHT_FAILED',
    });
  });
  if (!response.ok) {
    throw new ServerError(`Eidoverse could not load the resolved library asset ${path}.`, {
      status: 409,
      code: 'EIDOVERSE_ASSET_PREFLIGHT_FAILED',
    });
  }
}

async function unavailableLibraryAssets(paths, { signal, verifiedPaths = new Set() } = {}) {
  const candidates = [...new Set(paths)].filter((path) => path && !verifiedPaths.has(path));
  const checks = await Promise.all(candidates.map((path) => (
    verifyLibraryAsset(path, { signal }).then(
      () => {
        verifiedPaths.add(path);
        return null;
      },
      () => {
        throwIfAborted(signal);
        return path;
      },
    )
  )));
  return new Set(checks.filter(Boolean));
}

async function persistAssetLock(resolutions, runtimeVersion) {
  return mutateState((state) => {
    state.assetResolutions = resolutions;
    state.assetRecipeVersion = EIDOVERSE_ASSET_RECIPE_VERSION;
    state.recipe = resolveEidoverseDesign(state.userOverrides, state.assetResolutions);
    state.reconciliation = {
      ...state.reconciliation,
      status: 'applying',
      checkpoint: 'asset-preflight-complete',
      error: null,
      errorCode: null,
      errorContext: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      planFingerprint: null,
      operationCount: 0,
      appliedOperations: 0,
      compensationStatus: null,
      runtimeVersion,
    };
    return configFromState(state, getCosPresence());
  });
}

async function measureAssetLocks(resolutions, overrides, existing, { signal } = {}) {
  const locks = { ...resolutions };
  for (const [slot, path] of Object.entries(overrides)) {
    if (locks[slot]?.path === path) continue;
    locks[slot] = { slot, path, userOverride: true };
  }
  const byPath = new Map();
  for (const lock of [...Object.values(existing), ...Object.values(locks)]) {
    const bounds = eidoverseModelBounds(lock?.bounds);
    if (bounds) byPath.set(lock.path, Promise.resolve(bounds));
  }
  for (const lock of Object.values(locks)) {
    if (byPath.has(lock.path)) continue;
    byPath.set(lock.path, fetchLibraryJson('/geom', { lib: lock.path }, { signal }).then((geometry) => {
      const bounds = eidoverseModelBounds(geometry?.bbox);
      if (!bounds) throw new ServerError('Eidoverse returned invalid model bounds. Update its model geometry and retry.', {
        status: 503, code: 'EIDOVERSE_ASSET_GEOMETRY_INVALID',
      });
      return bounds;
    }));
  }
  return Object.fromEntries(await Promise.all(Object.entries(locks).map(async ([slot, lock]) =>
    [slot, { ...lock, bounds: await byPath.get(lock.path) }])));
}

async function prepareCityAssetLock(resolutions, config, runtimeVersion, { signal } = {}) {
  const overrides = config.design?.userOverrides?.assets || {};
  const measured = await measureAssetLocks(resolutions, overrides, config.design?.assetResolutions || {}, { signal });
  if (!overrides.citySurface) {
    // The authored coast fits the shipped footprint. Preserve customized land
    // and district positions rather than raising scenery through their halls.
    const defaultDistricts = DEFAULT_EIDOVERSE_PROJECTION_RECIPE.districts;
    const fitsLandscape = config.recipe.districts.length === defaultDistricts.length
      && config.recipe.districts.every(({ id, anchor }) => canonicalStringify(anchor)
        === canonicalStringify(defaultDistricts.find((district) => district.id === id)?.anchor))
      && canonicalStringify(config.recipe.environment.terrain)
        === canonicalStringify(DEFAULT_EIDOVERSE_PROJECTION_RECIPE.environment.terrain);
    const surface = buildEidoverseCitySurface(config.recipe.districts, {
      landscape: runtimeVersion?.capabilities?.largeWorldColliders === 1 && fitsLandscape,
    });
    const head = await waitWithSignal(fetch(libraryUrl(`/library/${surface.path}`), { method: 'HEAD', signal }), signal);
    if (head.status === 404) {
      const response = await waitWithSignal(fetch(libraryUrl('/upload', { by: 'portos', name: 'PortOS Commons paving and signs' }), {
        method: 'POST', headers: { 'content-type': 'model/gltf-binary' }, body: surface.bytes, signal,
      }), signal);
      if (!response.ok) throw new ServerError(`Eidoverse could not accept the Commons scene asset (HTTP ${response.status}).`, {
        status: 503, code: 'EIDOVERSE_CITY_ASSET_UNAVAILABLE',
      });
      const uploaded = await response.json();
      if (uploaded?.path !== surface.path) throw new ServerError('Eidoverse returned an unexpected Commons asset address.', {
        status: 503, code: 'EIDOVERSE_CITY_ASSET_INVALID',
      });
      await verifyLibraryAsset(surface.path, { signal });
    } else if (!head.ok) {
      throw new ServerError(`Eidoverse could not verify the Commons scene asset (HTTP ${head.status}).`, {
        status: 503, code: 'EIDOVERSE_CITY_ASSET_UNAVAILABLE',
      });
    }
    measured.citySurface = { slot: 'citySurface', path: surface.path, bytes: surface.bytes.length,
      designVersion: EIDOVERSE_WORLD_DESIGN_VERSION, assetRecipeVersion: EIDOVERSE_ASSET_RECIPE_VERSION,
      recipeFingerprint: surface.fingerprint, strategy: 'generated', source: 'generated',
      shippedDefault: true, userOverride: false };
  }
  return persistAssetLock(measured, runtimeVersion);
}

export async function resolveAndLockAssets(config, { signal } = {}) {
  const runtimeVersion = await preflightEidoverseProtocol({ signal });
  const existing = config.design?.assetResolutions || {};
  const overrides = config.design?.userOverrides?.assets || {};
  const explicitOverrides = Object.values(overrides);
  if (explicitOverrides.some((path) => !isValidEidoverseAssetOverridePath(path))) {
    throw new ServerError('A preserved Eidoverse asset override is invalid. Reset the affected asset slot, then retry.', {
      status: 409,
      code: 'EIDOVERSE_ASSET_OVERRIDE_INVALID',
    });
  }
  const lockInspection = inspectEidoverseAssetResolutionLocks({ existing, overrides });
  const verifiedPaths = new Set();
  const unavailablePaths = await unavailableLibraryAssets([
    ...Object.values(lockInspection.resolutions).map(({ path }) => path),
    ...explicitOverrides,
  ], { signal, verifiedPaths });
  const unavailableOverrideSlots = Object.entries(overrides)
    .filter(([, path]) => unavailablePaths.has(path))
    .map(([slot]) => slot);
  if (unavailableOverrideSlots.length) {
    throw new ServerError(`Eidoverse could not load the local asset override for: ${unavailableOverrideSlots.join(', ')}. Clear or replace the override, then retry.`, {
      status: 409,
      code: 'EIDOVERSE_ASSET_OVERRIDE_UNAVAILABLE',
      context: { missing: unavailableOverrideSlots },
    });
  }
  if (lockInspection.current && unavailablePaths.size === 0) {
    return prepareCityAssetLock(lockInspection.resolutions, config, runtimeVersion, { signal });
  }

  const files = await fetchLibraryJson('/library-list', { dir: 'eidoverse/assets/models' }, { signal });
  if (!Array.isArray(files)) {
    throw new ServerError('Eidoverse returned an invalid model-library catalog.', {
      status: 503,
      code: 'EIDOVERSE_ASSET_LIBRARY_INVALID',
    });
  }

  const recipe = config.recipe.assetRecipe;
  const resolvedAt = new Date().toISOString();
  const searchResults = {};
  const resolveAvailable = () => resolveEidoverseAssetRecipe({
    files: files.filter((candidate) => !unavailablePaths.has(candidate?.path || candidate)),
    searchResults: Object.fromEntries(Object.entries(searchResults).map(([query, candidates]) => [
      query,
      candidates.filter((candidate) => !unavailablePaths.has(candidate?.path)),
    ])),
    existing: Object.fromEntries(Object.entries(existing).filter(([, lock]) => (
      !unavailablePaths.has(typeof lock === 'string' ? lock : lock?.path)
    ))),
    overrides,
    resolvedAt,
  });
  const unresolvedError = (missing) => new ServerError(`Eidoverse is missing required PortOS world assets: ${missing.join(', ')}.`, {
    status: 409,
    code: 'EIDOVERSE_ASSET_RECIPE_UNRESOLVED',
    context: { missing, assetRecipeVersion: EIDOVERSE_ASSET_RECIPE_VERSION },
  });
  const resolveVerified = async (attempt = 0) => {
    const result = resolveAvailable();
    if (result.missing.length) {
      const unresolvedSlots = result.missing.map((slotName) => recipe.slots[slotName]).filter(Boolean);
      const queries = [...new Set(unresolvedSlots
        .flatMap((slot) => slot.fallbackQueries)
        .filter((query) => query && !Object.hasOwn(searchResults, query)))];
      if (queries.length === 0) throw unresolvedError(result.missing);
      const searchPairs = await Promise.all(queries.map(async (query) => {
        const candidates = await fetchLibraryJson('/library-models', { q: query }, { signal });
        if (!Array.isArray(candidates)) {
          throw new ServerError('Eidoverse returned invalid model search results.', {
            status: 503,
            code: 'EIDOVERSE_ASSET_LIBRARY_INVALID',
          });
        }
        return [query, candidates];
      }));
      Object.assign(searchResults, Object.fromEntries(searchPairs));
      return resolveVerified(attempt + 1);
    }
    const failedPaths = await unavailableLibraryAssets(
      Object.values(result.resolutions).map(({ path }) => path),
      { signal, verifiedPaths },
    );
    if (failedPaths.size === 0) return result;
    for (const path of failedPaths) unavailablePaths.add(path);
    if (attempt >= files.length + Object.keys(recipe.slots).length) {
      throw unresolvedError(Object.keys(recipe.slots));
    }
    return resolveVerified(attempt + 1);
  };
  const result = await resolveVerified();

  return prepareCityAssetLock(result.resolutions, config, runtimeVersion, { signal });
}

/** Fail closed when the managed renderer cannot isolate browser guest identity. */
export async function supportsEidoverseGuestEntry() {
  const response = await fetch(libraryUrl('/version'), { signal: AbortSignal.timeout(3000) }).catch(() => null);
  if (!response?.ok) return false;
  const version = await response.json().catch(() => null);
  return version?.capabilities?.guestEntry === 1;
}
