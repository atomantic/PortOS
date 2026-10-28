import { WORKSPACE_TEST_CACHE_ROOTS } from './workspaceTestCacheRoots.js';

// Recognizers for Vitest's module cache, used only where ignored payload still
// needs a content check (retirement of a checkout whose commits are not integrated).
export const VITEST_CACHE_TAG = 'Signature: 8a477f597d28d172789f06886806bc55\n# This file is a cache directory tag created by Vitest.';
export const VITEST_MODULE_CACHE_ROOTS = Object.values(WORKSPACE_TEST_CACHE_ROOTS).map(cache => `${cache.workspace}/${cache.cacheDir}/modules`);
export const moduleCacheName = name => /^(?:[a-f0-9]{40}|[a-f0-9]{64}|CACHEDIR\.TAG|_metadata\.json)$/.test(name);
export const moduleCacheMetadata = metadata => metadata !== null && typeof metadata === 'object'
  && !Array.isArray(metadata) && Object.keys(metadata).length === 1
  && typeof metadata.lockfileHash === 'string' && [8, 40, 64].includes(metadata.lockfileHash.length)
  && !/[^a-f0-9]/.test(metadata.lockfileHash);
