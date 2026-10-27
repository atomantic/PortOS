import { basename, dirname, join, resolve, sep } from 'node:path';
import { PATHS, resolveImageInputPath, sha256File } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';

const IMAGE_ROOTS = ['images', 'imageRefs', 'visualTemplates', 'imageCleanTmp', 'federatedMediaInbox'];
const SHA256 = /^[a-f0-9]{64}$/i;
const safeFilename = value => typeof value === 'string' && value !== '.' && value !== '..'
  && value.length > 0 && value.length <= 256 && basename(value) === value && !value.includes('\\');

const REQUEST_ROLES = ['request-reference', 'request-init'];
const isCanonImage = asset => !REQUEST_ROLES.includes(asset?.role);
const hasFingerprint = asset => Boolean(asset) && (Object.hasOwn(asset, 'inputRoot') || Object.hasOwn(asset, 'sha256'));

async function fingerprintImage(path, subject) {
  const inputRoot = IMAGE_ROOTS.find(key => resolve(PATHS[key]) === resolve(dirname(path)));
  const sha256 = inputRoot ? await sha256File(path).catch(() => null) : null;
  if (!sha256 || !safeFilename(basename(path))) throw new ServerError(`${subject} could not be fingerprinted for FableLoom provenance.`, { status: 400, code: 'FABLELOOM_IMAGE_UNREADABLE' });
  return { filename: basename(path), inputRoot, sha256 };
}

export async function captureRequestImage(path, role, strength) {
  return { role, bindingId: null, required: true, ...await fingerprintImage(path, 'A requested image'),
    ...(strength != null ? { strength } : {}) };
}

/** Record which file and bytes each compiled canon image resolved to; `paths` is aligned with `assets`. */
export async function captureCanonImages(assets, paths) {
  return Promise.all(assets.map(async (asset, index) => ({
    ...asset, ...await fingerprintImage(paths[index], `Canon image "${asset.filename}"`),
  })));
}

/** Image canon assets recorded before canon fingerprints existed cannot prove what was sent. */
export function unfingerprintedCanonImages(manifest) {
  if (manifest?.capability?.kind === 'video') return [];
  return (manifest?.assets || []).filter(asset => isCanonImage(asset) && !hasFingerprint(asset))
    .map(asset => asset.filename || 'unknown');
}

function adapterPath(adapter) {
  if (adapter?.source === 'Request adapter' && typeof adapter.relativePath !== 'string') return null;
  const name = adapter?.relativePath || adapter?.filename;
  if (typeof name !== 'string' || name.length > 512 || name.includes('\\')
    || name.split('/').some(segment => !segment || segment === '.' || segment === '..')
    || !safeFilename(adapter?.filename) || name.split('/').at(-1) !== adapter.filename) return null;
  const path = resolve(PATHS.loras, ...name.split('/'));
  return path.startsWith(`${resolve(PATHS.loras)}${sep}`) ? path : null;
}

async function checkedDigest(path, expected) {
  if (!path || typeof expected !== 'string' || !SHA256.test(expected)) return false;
  return (await sha256File(path).catch(() => null))?.toLowerCase() === expected.toLowerCase();
}

/** Reconstruct only recorded explicit inputs, preserving root identity and fresh content hashes. */
export async function restoreRequestInputs(manifest) {
  const refs = [];
  const strengths = [];
  const canon = [];
  let init = null;
  let initStrength;
  for (const [index, asset] of (manifest.assets || []).entries()) {
    const canonImage = isCanonImage(asset);
    // A canon image without a fingerprint predates this evidence; the caller decides how to treat it.
    if (canonImage && !hasFingerprint(asset)) {
      canon.push(null);
      continue;
    }
    const label = canonImage ? 'Canon image' : 'Authored image';
    if (!IMAGE_ROOTS.includes(asset.inputRoot) || !safeFilename(asset.filename)) return { error: `${canonImage ? 'A canon' : 'An authored'} image has no verifiable source.` };
    const path = resolve(PATHS[asset.inputRoot], asset.filename);
    if (resolveImageInputPath(path) !== path || !await checkedDigest(path, asset.sha256)) return { error: `${label} "${asset.filename}" is unavailable or changed.` };
    if (canonImage) {
      canon.push(path);
      continue;
    }
    if (asset.role === 'request-init') {
      if (init) return { error: 'More than one authored init image was recorded.' };
      init = path;
      initStrength = asset.strength;
    } else {
      const strength = manifest.referenceImageStrengths?.[index];
      if (!Number.isFinite(strength) || strength < 0 || strength > 1) return { error: `Authored image "${asset.filename}" has no verifiable strength.` };
      refs.push(path);
      strengths.push(strength);
    }
  }
  const adapters = [];
  const scales = [];
  for (const adapter of manifest.adapters || []) {
    if (adapter.source !== 'Request adapter') continue;
    const path = adapterPath(adapter);
    if (!await checkedDigest(path, adapter.sha256)) return { error: `Authored adapter "${adapter.filename || 'unknown'}" is unavailable or changed.` };
    adapters.push(path);
    scales.push(adapter.scale);
  }
  return { refs, strengths, init, initStrength, adapters, scales, canon };
}

/** Hash only the adapters named by a recorded manifest, never the entire library. */
export async function recordedAdapterFiles(episode) {
  const manifests = (episode?.nodes || []).flatMap(node => [
    node.visualConditioning, node.playbackAssets?.provenance,
    ...Object.values(node.playbackAssets?.visualConditioningByAsset || {}),
  ]).filter(Boolean);
  const adapters = manifests.flatMap(manifest => [
    ...(manifest.adapters || []),
    ...(manifest.characters || []).flatMap(character => character.lora ? [character.lora] : []),
  ]);
  const unique = new Map(adapters.map(adapter => [`${adapter.relativePath || adapter.filename}`, adapter]));
  return Promise.all([...unique.values()].map(async adapter => {
    const path = adapterPath(adapter);
    const sha256 = path ? await sha256File(path).catch(() => null) : null;
    return { filename: adapter.filename, ...(adapter.relativePath ? { relativePath: adapter.relativePath } : {}), sha256 };
  }));
}

/** Verify captured evidence against the actual queue request just before dispatch. */
export async function assertFableLoomDispatchInputs(params) {
  const manifest = params?.visualConditioning;
  if (!params?.fableLoom || typeof manifest?.authoredPrompt !== 'string') return;
  const fail = message => { throw new ServerError(`FableLoom input changed while queued: ${message}`, { status: 409, code: 'FABLELOOM_INPUT_CHANGED' }); };
  const recorded = await restoreRequestInputs(manifest);
  if (recorded.error) fail(recorded.error);
  const assets = (manifest.assets || []).filter(asset => asset.role !== 'request-init');
  const refs = Array.isArray(params.referenceImagePaths) ? params.referenceImagePaths : [];
  const strengths = Array.isArray(params.referenceImageStrengths) ? params.referenceImageStrengths : [];
  if (refs.length !== assets.length || strengths.length !== refs.length
    || strengths.some((strength, index) => strength !== manifest.referenceImageStrengths?.[index])) fail('reference image order or strength differs from the recorded request.');
  let explicitIndex = 0;
  let canonIndex = 0;
  for (const [index, asset] of assets.entries()) {
    if (typeof refs[index] !== 'string' || basename(refs[index]) !== asset.filename) fail('reference image order differs from the recorded request.');
    if (asset.role === 'request-reference' && resolve(refs[index]) !== recorded.refs[explicitIndex++]) fail('an authored reference path differs from its recorded source.');
    if (isCanonImage(asset)) {
      // Jobs queued before canon fingerprints keep the basename check they were queued under.
      const canonPath = recorded.canon[canonIndex++];
      if (canonPath && resolve(refs[index]) !== canonPath) fail(`canon image "${asset.filename}" differs from its recorded source.`);
    }
  }
  if ((params.initImagePath ? resolve(params.initImagePath) : null) !== recorded.init
    || (params.initImageStrength ?? null) !== (recorded.initStrength ?? null)) fail('init image or strength differs from the recorded request.');
  const paths = [
    ...(params.loraFilenames || []).map(name => join(PATHS.loras, basename(name))),
    ...(params.loraPaths || []),
  ];
  const adapters = manifest.adapters || [];
  const scales = params.loraScales || [];
  if (paths.length !== adapters.length || scales.length !== adapters.length) fail('adapter order or scale differs from the recorded request.');
  for (const [index, adapter] of adapters.entries()) {
    const expected = adapterPath(adapter);
    if (!expected || typeof paths[index] !== 'string' || resolve(paths[index]) !== expected
      || scales[index] !== adapter.scale || !await checkedDigest(expected, adapter.sha256)) fail(`adapter "${adapter.filename || 'unknown'}" is unavailable or changed.`);
  }
  if (params.prompt !== manifest.compiledPrompt || (params.negativePrompt || '') !== manifest.compiledNegativePrompt) fail('prompt differs from the recorded request.');
  if (manifest.capability?.backend === 'local') {
    if (typeof manifest.renderedPrompt !== 'string') fail('the actual adapter activation prompt was not recorded.');
    const [{ readTriggerWordsByFilename }, { weaveLoraTriggers }] = await Promise.all([
      import('../loras.js'), import('../../lib/loraTriggers.js'),
    ]);
    const words = await readTriggerWordsByFilename(paths);
    if (weaveLoraTriggers(params.prompt, paths.map(path => words[basename(path)])).prompt !== manifest.renderedPrompt) fail('adapter activation words changed.');
  }
}
