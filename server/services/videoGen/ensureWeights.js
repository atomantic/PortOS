import { readFile, stat } from 'node:fs/promises';
import { findCachedRepoFile, isSafeHfRepoRelativePath } from '../../lib/hfCache.js';
import { ServerError } from '../../lib/errorHandler.js';
import { downloadHfRepo } from '../hfDownload.js';
import { sha256File } from '../../lib/fileUtils.js';
import { MINIMAX_H3_LIGHTX2V_PROFILE, MINIMAX_H3_FLEX_MLX_PROFILE, miniMaxH3SpeedProfileContract, isMiniMaxH3SpeedProfileRequest, miniMaxH3SpeedProfileDeclineReason } from '../../lib/minimaxH3SpeedProfiles.js';
import { acceptedVideoModelTerms, isVideoModelTermsAccepted, videoModelTermsError } from '../../lib/videoDisclosure.js';
import { resolveByovRuntimeLoraCapable, resolveMiniMaxH3MlxSpeedCapable } from './runtimes.js';
import { readSafetensorsHeader } from '../../lib/safetensors.js';

export async function validateMiniMaxH3CudaLoras(loras, speedProfile = null) {
  const seen = new Set(speedProfile ? [speedProfile.adapter.sha256] : []);
  const { hiddenSize: hidden, attentionSize: attention, ffnSize: ffn, layers, refinerLayers } = MINIMAX_H3_LIGHTX2V_PROFILE.geometry;
  const shapes = { 'attn.to_q': [attention, hidden], 'attn.to_k': [attention, hidden],
    'attn.to_v': [attention, hidden], 'attn.to_out.0': [hidden, attention],
    'ff.net.0.proj': [ffn * 2, hidden], 'ff.net.2': [hidden, ffn] };
  for (const lora of loras || []) {
    const refuse = () => { throw new ServerError('H3 CUDA requires complete split Diffusers A/B safetensors with numeric alpha metadata and H3 projection dimensions. Native/fused/ComfyUI adapters must be re-exported first.',
      { status: 400, code: 'MINIMAX_H3_LORA_LAYOUT_UNSUPPORTED' }); };
    const header = await readSafetensorsHeader(lora.path);
    const alpha = Number(header?.__metadata__?.alpha);
    if (!header || typeof header.__metadata__?.alpha !== 'string'
      || !Number.isFinite(alpha) || alpha <= 0 || !Number.isFinite(lora.strength)) refuse();
    const pairs = new Map();
    for (const [key, descriptor] of Object.entries(header)) {
      if (key === '__metadata__') continue;
      const match = key.match(/^(?:transformer\.)?((transformer_blocks|token_refiner\.refiner_blocks)\.(0|[1-9]\d*)\.(.+))\.lora_([AB])(?:\.default)?\.weight$/);
      if (!match) refuse();
      const [, target, block, index, projection, side] = match;
      const expected = shapes[projection];
      const shape = descriptor?.shape;
      if (!expected || Number(index) >= (block === 'transformer_blocks' ? layers : refinerLayers)
        || !['BF16', 'F16', 'F32'].includes(descriptor?.dtype)
        || !Array.isArray(shape) || shape.length !== 2 || shape.some((n) => !Number.isInteger(n) || n <= 0)
        || (side === 'A' ? shape[1] !== expected[1] : shape[0] !== expected[0])) refuse();
      const pair = pairs.get(target) || {};
      if (pair[side]) refuse();
      pair[side] = shape;
      pairs.set(target, pair);
    }
    if (!pairs.size || [...pairs.values()].some((p) => !p.A || !p.B || p.A[0] !== p.B[1])) refuse();
    const digest = await sha256File(lora.path);
    if (!speedProfile && digest === MINIMAX_H3_LIGHTX2V_PROFILE.adapter.sha256) {
      throw new ServerError('The LightX2V v1.3 adapter requires its named Speed profile. Remove it from the user LoRA stack and select LightX2V under Speed.', { status: 400, code: 'MINIMAX_H3_LORA_PROFILE_REQUIRED' });
    }
    if (seen.has(digest)) throw new ServerError('The same H3 CUDA adapter was selected more than once, including the LightX2V speed adapter.', { status: 400, code: 'MINIMAX_H3_LORA_DUPLICATE' });
    seen.add(digest);
  }
}

// MLX retains its existing format support. Identity is content-based so a
// renamed speed adapter cannot run under the stock schedule or attach twice.
export async function validateMiniMaxH3MlxLoras(loras, speedProfile = null) {
  const seen = new Set(speedProfile ? [speedProfile.adapter.sha256] : []);
  for (const lora of loras || []) {
    const digest = await sha256File(lora.path);
    if (seen.has(digest)) throw new ServerError('The same H3 adapter was selected more than once, including the LightX2V speed adapter.', { status: 400, code: 'MINIMAX_H3_LORA_DUPLICATE' });
    if ([MINIMAX_H3_LIGHTX2V_PROFILE, MINIMAX_H3_FLEX_MLX_PROFILE].some((profile) => digest === profile.adapter.sha256 && speedProfile?.id !== profile.id)) {
      throw new ServerError('This distilled adapter requires its own named MLX Speed profile. Remove it from the user LoRA stack and select its profile under Speed.', { status: 400, code: 'MINIMAX_H3_LORA_PROFILE_REQUIRED' });
    }
    seen.add(digest);
  }
}

// Each explicit request checks the cache and digest; never download from a
// render path, and never treat a revision pointer alone as content integrity.
export async function prepareMiniMaxH3SpeedProfile(params, settings) {
  if (!isMiniMaxH3SpeedProfileRequest(params.profileId)) return null;
  const reason = miniMaxH3SpeedProfileDeclineReason(params);
  if (reason) throw new ServerError(reason.message, { status: 400, code: reason.code });
  if (!isVideoModelTermsAccepted(params.model, acceptedVideoModelTerms(settings))) throw videoModelTermsError(params.model);
  if ((params.model.runtime === 'minimax_h3' && !(await resolveMiniMaxH3MlxSpeedCapable(params.profileId)))
    || !(await resolveByovRuntimeLoraCapable(params.model.runtime))) {
    throw new ServerError('This speed profile requires its pinned H3 runtime and scheduler/quantized-LoRA capability probes. Install or repair the selected MiniMax H3 runtime in Video Gen.',
      { status: 400, code: 'MINIMAX_H3_SPEED_RUNTIME_UNSUPPORTED' });
  }
  const profile = miniMaxH3SpeedProfileContract(params.profileId);
  const adapter = profile.adapter;
  const path = await findCachedRepoFile(adapter.repo, adapter.file, { revision: adapter.revision });
  const info = path ? await stat(path).catch(() => null) : null;
  const digest = info?.isFile() && info.size === adapter.sizeBytes ? await sha256File(path).catch(() => null) : null;
  if (digest !== adapter.sha256) {
    throw new ServerError('Speed profile weights are missing or fail the pinned SHA-256 check. Use Download adapter beside the Speed selector in Video Gen; generation never downloads this adapter.',
      { status: 400, code: 'MINIMAX_H3_SPEED_WEIGHTS_NOT_CACHED' });
  }
  for (const [file, expected] of Object.entries(adapter.supportFiles || {})) {
    const supportPath = await findCachedRepoFile(adapter.repo, file, { revision: adapter.revision });
    if (!supportPath || await sha256File(supportPath).catch(() => null) !== expected) {
      throw new ServerError('Speed profile manifest, license or notice is missing or changed. Download the adapter again in Video Gen.',
        { status: 400, code: 'MINIMAX_H3_SPEED_WEIGHTS_NOT_CACHED' });
    }
  }
  if (params.model.runtime === 'minimax_h3') await ensureMiniMaxH3Weights(params.model, { cacheOnly: true });
  return { ...profile, adapterPath: path };
}

// The MLX transformer repo has no registry file list: its index owns the shard
// inventory. Check metadata too, since a weight-only cache badge misses it.
const transformerFiles = ['config.json', 'quant_config.json', 'model.safetensors.index.json'];
const targetIsCached = async ({ repo, revision, only, indexed }) => {
  const files = indexed ? transformerFiles : only;
  const paths = await Promise.all(files.map((file) => findCachedRepoFile(repo, file, { revision })));
  if (paths.some((path) => !path)) return false;
  if (!indexed) return true;
  let index;
  try {
    index = JSON.parse(await readFile(paths[2], 'utf8'));
  } catch { return false; }
  const shards = [...new Set(Object.values(index.weight_map || {}))];
  if (!shards.length || shards.some((file) => !isSafeHfRepoRelativePath(file))) return false;
  return (await Promise.all(shards.map((file) => findCachedRepoFile(repo, file, { revision })))).every(Boolean);
};

// Called only for an explicit render, after input/hardware validation. Keep the
// Python renderer offline and finish provisioning before it is spawned.
export async function ensureMiniMaxH3Weights(model, { cacheOnly = false } = {}) {
  if (model.runtime !== 'minimax_h3') return;
  const targets = [{ repo: model.repo, revision: model.revision,
    only: model.repoFiles || [], indexed: !model.repoFiles?.length },
  ...(model.requiredWeights || []).map((dep) => ({ ...dep, only: dep.files || [] }))];
  for (const target of targets) {
    if (!target.repo || (!target.indexed && !target.only.length)
        || target.only.some((file) => !isSafeHfRepoRelativePath(file))) {
      throw new ServerError('MiniMax H3 has an invalid weight manifest.', { status: 500, code: 'VIDEO_MODEL_MISCONFIGURED' });
    }
    if (await targetIsCached(target)) continue;
    if (cacheOnly) throw new ServerError('MiniMax H3 profile rendering requires all pinned base weights already cached. Download the model explicitly in Video Gen.',
      { status: 400, code: 'MINIMAX_H3_WEIGHTS_NOT_CACHED' });
    console.log('⬇️ MiniMax H3: completing missing model files before rendering');
    const result = await downloadHfRepo({ repo: target.repo, revision: target.revision || null, only: target.only }).promise;
    if (!result.ok || !(await targetIsCached(target))) {
      throw new ServerError('MiniMax H3 automatic download did not complete the required model files. Retry when the download service is available.',
        { status: 400, code: 'MINIMAX_H3_WEIGHTS_NOT_CACHED' });
    }
  }
}
