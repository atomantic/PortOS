/** Pure media model predicates and Hugging Face repo, cache, and download target resolution. */

import { isFlux2 } from '../runners.js';
import { isNonBlankStr } from '../textUtils.js';

// Registry fields shared by FLUX.2 pin backfills and cache target resolution.
export const FLUX2_REVISION_FIELDS = [
  ['repo', 'revision'],
  ['tokenizerRepo', 'tokenizerRevision'],
  ['basePipelineRepo', 'basePipelineRevision'],
  ['kvRepo', 'kvRevision'],
];

export const isEditOnly = (model) => model?.editOnly === true;

/**
 * Every pinned file group a model needs resolvable in the HF cache.
 *
 * Two shapes, and a caller that checks only one gets the other wrong: a
 * selective row pins its subset with `repoFiles` against its OWN repo (the H3
 * CUDA entry, whose base repo is ~498 GB and whose diffusers layout is ~144 GB
 * of it), while a row that composes weights from a SECOND repo pins them in
 * `requiredWeights` (the H3 MLX entry's upstream FL2VA checkpoint). Checking
 * `requiredWeights` alone reports a half-downloaded CUDA model as complete.
 *
 * An empty result means "the base snapshot is the whole answer".
 */
export const requiredModelCacheGroups = (model) => {
  const groups = [];
  if (Array.isArray(model?.repoFiles)) {
    groups.push({ repo: model.repo, revision: model.revision, files: model.repoFiles });
  }
  if (Array.isArray(model?.requiredWeights)) groups.push(...model.requiredWeights);
  return groups;
};

// Map a registry entry to the HuggingFace repo id whose weights need to be
// resident on disk before generation can run. Used by the download-status
// badge on the image/video gen forms.
//
// Most entries already carry `repo` directly. mflux's legacy `dev` / `schnell`
// ids predate the field and resolve to the canonical Black Forest Labs repos
// at runtime via the `mflux-generate` CLI — hardcode those two so the badge
// can probe their HF cache the same way as every other model.
const MFLUX_LEGACY_REPOS = {
  dev: 'black-forest-labs/FLUX.1-dev',
  schnell: 'black-forest-labs/FLUX.1-schnell',
};

export const repoForModel = (model) => {
  if (!model || typeof model !== 'object') return null;
  if (isNonBlankStr(model.repo)) return model.repo;
  if (MFLUX_LEGACY_REPOS[model.id]) return MFLUX_LEGACY_REPOS[model.id];
  return null;
};

// Cache operations must use the same revisions as the runner, including any
// auxiliary weights. A repo can supply components from distinct snapshots.
export const requiredRepoSpecsForModel = (model) => {
  const main = repoForModel(model);
  if (!main) return null;
  const sources = [
    [main, model.revision],
    [model.textEncoderRepo, model.textEncoderRevision],
  ];
  if (isFlux2(model)) {
    for (const [repoKey, revisionKey] of FLUX2_REVISION_FIELDS.slice(1)) {
      sources.push([model[repoKey], model[revisionKey]]);
    }
  }
  const specs = [];
  for (const [repo, pin] of sources) {
    const revision = pin || null;
    if (isNonBlankStr(repo) && !specs.some(spec => spec.repo === repo && spec.revision === revision)) {
      specs.push({ repo, revision });
    }
  }
  return specs;
};

export const requiredReposForModel = (model) => requiredRepoSpecsForModel(model)?.map(({ repo }) => repo) ?? null;

// Pinned `{ repo, revision, only }` download targets for an image model that
// narrows its repos to exact files (`repoFiles` / `requiredWeights[].files`).
// `null` means the model is a whole-repo snapshot and uses
// `requiredRepoSpecsForModel` instead.
export const imageModelDownloadTargets = (model) => {
  const deps = Array.isArray(model?.requiredWeights) ? model.requiredWeights : [];
  if (!Array.isArray(model?.repoFiles) && !deps.length) return null;
  const main = repoForModel(model);
  if (!main) return null;
  return [
    { repo: main, revision: model.revision || null, only: [...(model.repoFiles || [])] },
    ...deps.filter(dep => isNonBlankStr(dep?.repo) && Array.isArray(dep.files) && dep.files.length)
      .map(dep => ({ repo: dep.repo, revision: dep.revision || null, only: [...dep.files] })),
  ];
};

// `getTextEncoderRepo()` can return either an HF repo id (`org/name`) or a
// resolved local filesystem path when the registry entry has a `localPath`
// override. Only `org/name` is a valid input to HF-cache inspection /
// download endpoints.
//
// Reject local-path shapes across platforms:
//  - POSIX absolute / home-relative: `/foo/bar`, `~/foo`
//  - Windows drive paths (both backslash and forward-slash style): `C:\…`,
//    `C:/Users/…` — without this check, a Windows install with a
//    forward-slash-style localPath text encoder would be misclassified as
//    an HF repo, triggering bogus cache inspection / download requests.
//  - Windows UNC paths: `\\server\share\…`
//  - Any path containing a backslash (Windows separator)
// Then require exactly one `/` separator — standard HF repo ids are the
// `org/name` shape; zero (`legacy-bare-name`) and multiple (a path) are not.
export const isHfRepoId = (value) => {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.startsWith('/') || value.startsWith('~')) return false;
  if (value.includes('\\')) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  return (value.match(/\//g) || []).length === 1;
};
