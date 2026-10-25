/** Machine-local, proven-successful Metal buffer policies. No render content is stored. */
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { totalmem } from 'node:os';
import { z } from 'zod';
import { atomicWrite, PATHS } from '../../lib/fileUtils.js';
import { createFileWriteQueue } from '../../lib/fileWriteQueue.js';

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 128;
const signatureSchema = z.string().regex(/^[a-f0-9]{64}$/);
const cacheSchema = z.object({
  version: z.literal(1),
  entries: z.array(z.object({ signature: signatureSchema, learnedAt: z.number().finite().nonnegative() }).strict()).max(MAX_ENTRIES),
}).strict();
const digest = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

export function createMetalBufferProfiles({ file, now = Date.now, read = readFile, write = atomicWrite }) {
  const queue = createFileWriteQueue();
  let epoch = 0;
  const load = async () => {
    const result = await read(file, 'utf8').then(text => ({ text }), error => ({ error }));
    if (result.error) return result.error.code === 'ENOENT'
      ? { entries: [], diagnostic: 'empty' } : { entries: null, diagnostic: 'unreadable' };
    const parsed = cacheSchema.safeParse(await Promise.resolve().then(() => JSON.parse(result.text)).catch(() => null));
    if (!parsed.success) return { entries: null, diagnostic: 'invalid-or-unknown-version' };
    return { entries: parsed.data.entries.filter(entry => entry.learnedAt <= now() && now() - entry.learnedAt < TTL_MS), diagnostic: 'ready' };
  };
  const save = entries => write(file, { version: 1, entries });
  return {
    lookup: signature => {
      const startedEpoch = epoch;
      return queue(async () => {
        const state = await load();
        return { signature, epoch: startedEpoch, applied: startedEpoch === epoch && !!state.entries?.some(entry => entry.signature === signature), diagnostic: state.diagnostic };
      });
    },
    learn: token => queue(async () => {
      if (!token || token.epoch !== epoch || !signatureSchema.safeParse(token.signature).success) return { learned: false, diagnostic: 'invalidated' };
      const state = await load();
      if (!state.entries) return { learned: false, diagnostic: state.diagnostic };
      const entries = [...state.entries.filter(entry => entry.signature !== token.signature), { signature: token.signature, learnedAt: now() }]
        .sort((a, b) => a.learnedAt - b.learnedAt).slice(-MAX_ENTRIES);
      await save(entries);
      return { learned: true };
    }),
    invalidate: token => {
      epoch += 1;
      return queue(async () => {
        const state = await load();
        if (state.entries) await save(state.entries.filter(entry => entry.signature !== token.signature));
        return { diagnostic: state.diagnostic };
      });
    },
    clear: () => {
      // Fence learning immediately, including jobs whose success is still awaiting publication.
      epoch += 1;
      return queue(async () => { await save([]); return { cleared: true }; });
    },
  };
}

// Exclude content and per-job destinations from the effective argv identity.
// Input counts and keyframe positions still participate; paths never reach disk.
const OMIT_VALUES = new Set(['--prompt', '--negative-prompt', '--seed', '--batch-seeds', '--output', '--preview-dir', '--batch-file', '--batch-json', '--prompt-cache-dir', '--prompt-embedding-cache-dir', '--text-encoder-shim-root', '--draft-decoder-shim-root']);
const INPUT_VALUES = new Set(['--image', '--last-image', '--audio', '--video', '--extend-from-video', '--ic-reference', '--reference-image', '--reference-video', '--reference-audio']);
const REVISION = /^[a-f0-9]{40}$/i;

export async function metalBufferExecutionSignature({ model, encoder, runtimeInfo, fingerprint, bin, args, meta, batch, env, policy }) {
  if (!REVISION.test(model?.revision || '') || !REVISION.test(runtimeInfo?.expectedRevision || '')
    || !fingerprint?.versions?.mlx || !fingerprint.python
    || (runtimeInfo.fingerprintPackages || []).some(name => !fingerprint.versions[name])
    || !fingerprint.chip || !fingerprint.os || fingerprint.chip === 'unknown'
    || (encoder && !REVISION.test(encoder.revision || ''))
    || (model.requiredWeights || []).some(weight => !REVISION.test(weight.revision || ''))) return null;
  const effectiveArgs = [];
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    if (OMIT_VALUES.has(flag)) { index += 1; continue; }
    if (INPUT_VALUES.has(flag)) { effectiveArgs.push(flag); index += 1; continue; }
    if (flag === '--keyframes-json') {
      const frames = JSON.parse(args[++index]);
      effectiveArgs.push(flag, frames.map(frame => frame.index));
      continue;
    }
    effectiveArgs.push(flag);
  }
  // Hash all shipped Python helpers: indirect imports and changed implicit
  // sampler defaults must invalidate as reliably as the entrypoint itself.
  const scripts = dirname(args[0]);
  const names = (await readdir(scripts)).filter(name => name.endsWith('.py')).sort();
  if (!names.length) return null;
  const helperHashes = await Promise.all(names.map(async name => [name, digest(await readFile(join(scripts, name)))]));
  const executable = await stat(bin);
  const performanceEnv = Object.fromEntries(['MLX_METAL_FAST_SYNCH', 'LTX2_DIT_EVAL_EVERY', 'LTX2_GEMMA_EVAL_EVERY', 'LTX2_GEMMA_MAX_LENGTH', 'PORTOS_MLX_CACHE_LIMIT_MB'].map(key => [key, env[key] ?? null]));
  const assetPaths = [...(encoder?.paths || [])];
  for (let index = 1; index < args.length; index += 1) {
    if (['--lora', '--text-encoder-file', '--draft-decoder-file', '--ic-lora-path', '--dev-transformer', '--distilled-lora'].includes(args[index])) assetPaths.push(args[index + 1]);
    if (args[index] === '--user-loras') assetPaths.push(...JSON.parse(args[index + 1]).map(item => item.path));
  }
  const assets = await Promise.all(assetPaths.map(async path => {
    const info = await stat(path);
    return [digest(path), info.size, info.mtimeMs, info.ctimeMs];
  }));
  return digest(canonical({
    policy, model: { id: model.id, runtime: model.runtime, repo: model.repo, revision: model.revision, requiredWeights: model.requiredWeights },
    encoder: encoder && { id: encoder.id, repo: encoder.repo, revision: encoder.revision },
    runtime: { fingerprint, revision: runtimeInfo.expectedRevision, executable: [executable.size, executable.mtimeMs, executable.ctimeMs] },
    helpers: helperHashes, assets, supervisor: digest(await readFile(new URL('./generateVideoHelpers.js', import.meta.url))),
    memoryBytes: totalmem(), performanceEnv, effectiveArgs,
    shape: { mode: meta.mode, width: meta.width, height: meta.height, numFrames: meta.numFrames, fps: meta.fps, steps: meta.steps, batchSize: batch?.length || 1 },
  }));
}

let profiles;
export const getMetalBufferProfiles = () => profiles ??= createMetalBufferProfiles({ file: join(PATHS.data, 'cache', 'video-gen', 'metal-buffer-profiles.json') });
export const clearMetalBufferProfiles = () => getMetalBufferProfiles().clear();
