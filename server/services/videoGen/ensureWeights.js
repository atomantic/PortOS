import { readFile } from 'node:fs/promises';
import { findCachedRepoFile, isSafeHfRepoRelativePath } from '../../lib/hfCache.js';
import { ServerError } from '../../lib/errorHandler.js';
import { downloadHfRepo } from '../hfDownload.js';

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
export async function ensureMiniMaxH3Weights(model) {
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
    console.log('⬇️ MiniMax H3: completing missing model files before rendering');
    const result = await downloadHfRepo({ repo: target.repo, revision: target.revision || null, only: target.only }).promise;
    if (!result.ok || !(await targetIsCached(target))) {
      throw new ServerError('MiniMax H3 automatic download did not complete the required model files. Retry when the download service is available.',
        { status: 400, code: 'MINIMAX_H3_WEIGHTS_NOT_CACHED' });
    }
  }
}
