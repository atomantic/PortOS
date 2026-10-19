import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDir, sha256File } from '../../lib/fileUtils.js';
import { verifySafetensorsStructure, repairCachedFile, aggregateVerifies } from '../../lib/hfCache.js';
import { assessDownloadPreflight, assertDownloadFits, streamResumableDownload, createDownloadSlot } from '../../lib/downloadPreflight.js';
import { MOSS_MANIFEST, mossSnapshot } from './mossRuntime.js';

const slots = createDownloadSlot({ codePrefix: 'MOSS', keepPartialOnCancel: true });

export async function verifyMossWeights({ deep = false } = {}) {
  const snapshotPath = mossSnapshot();
  const files = await Promise.all(MOSS_MANIFEST.files.map(async file => {
    const path = join(snapshotPath, file.path);
    const info = await stat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    let reason = !info ? 'missing-blob' : info.size !== file.size ? 'size-mismatch' : null;
    if (!reason && file.path.endsWith('.safetensors')) {
      const structure = await verifySafetensorsStructure(path, info.size);
      if (!structure.ok) reason = structure.reason;
    }
    // Small configuration/tokenizer files are always hashed; large tensors only on explicit deep verification.
    if (!reason && (deep || !file.path.endsWith('.safetensors')) && await sha256File(path) !== file.sha256) reason = 'hash-mismatch';
    return { name: file.path, path, ok: !reason, reason, sizeBytes: info?.size || 0 };
  }));
  const cached = files.every(file => file.ok);
  return { repoId: MOSS_MANIFEST.repo, snapshotPath, cached, checkedDeep: deep,
    status: cached ? 'ok' : files.some(file => file.reason === 'missing-blob') ? 'missing' : 'bad',
    sizeBytes: files.filter(file => file.ok).reduce((sum, file) => sum + file.sizeBytes, 0), files };
}

export async function mossModelCacheStatus(id) {
  const integrity = await verifyMossWeights();
  return { id, repo: MOSS_MANIFEST.repo, revision: MOSS_MANIFEST.revision, cached: integrity.cached,
    sizeBytes: integrity.sizeBytes, requiredRepos: [MOSS_MANIFEST.repo],
    pendingRepos: integrity.cached ? [] : [MOSS_MANIFEST.repo], integrity: aggregateVerifies([integrity]) };
}

export async function repairMossWeights({ deep = false } = {}) {
  const verify = await verifyMossWeights({ deep });
  const deleted = [];
  for (const file of verify.files.filter(file => !file.ok && file.reason !== 'missing-blob')) {
    if (await repairCachedFile(file.path, { snapshotPath: verify.snapshotPath })) deleted.push({ repo: MOSS_MANIFEST.repo, name: file.name });
  }
  return { deep, deleted, repos: [MOSS_MANIFEST.repo] };
}

export function downloadMossWeights(emit) {
  const destination = mossSnapshot();
  const slot = slots.claim(destination);
  const promise = (async () => {
    try {
      const verify = await verifyMossWeights({ deep: true });
      slot.throwIfAborted();
      const missing = MOSS_MANIFEST.files.filter(file => !verify.files.find(entry => entry.name === file.path)?.ok);
      await ensureDir(destination);
      const assessments = await Promise.all(missing.map(file => assessDownloadPreflight({ destPath: join(destination, file.path), expectedBytes: file.size })));
      const remaining = assessments.reduce((sum, assessment) => sum + Math.max(0, assessment.requiredBytes - assessment.headroomBytes), 0);
      assertDownloadFits(await assessDownloadPreflight({ destPath: destination, expectedBytes: remaining }));
      for (const [index, file] of missing.entries()) {
        slot.throwIfAborted();
        emit({ type: 'stage', stage: 'download', message: `${index + 1}/${missing.length}: ${file.path}` });
        const onBytes = slot.throttle((received, total) => emit({ type: 'progress', stage: 'download', file: file.path, progress: (index + received / (total || file.size)) / missing.length }));
        await streamResumableDownload({
          url: `https://huggingface.co/${MOSS_MANIFEST.repo}/resolve/${MOSS_MANIFEST.revision}/${file.path}`,
          destPath: join(destination, file.path), expectedSha256: file.sha256, onBytes, ...slot.downloadOptions(),
        });
      }
      slot.throwIfAborted();
      emit({ type: 'complete', message: 'Pinned MOSS SFT weights verified.' });
    } catch (error) {
      throw slot.wrapError(error);
    } finally { slot.release(); }
  })();
  return { promise, kill: () => slots.cancel(destination) };
}
