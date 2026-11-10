/**
 * Run the provider's delete call for a finished render: Runway deletes the task and its rendered asset (it keeps
 * its request history log with the input prompt and image), fal.ai deletes the request's stored payloads and output files, Higgsfield deletes the request's files, prompt and parameters. Runs on demand from the media details pane, or automatically
 * once the output is saved locally when `imageGen.<provider>.deleteAfterDownload` is on (one
 * toggle per provider, covering its image and video renders). The record keeps its provider id
 * and gains a deleted-at stamp, so the details pane can say it was done.
 */

import { ServerError } from '../lib/errorHandler.js';
import { deleteRunwayTask, resolveRunwayApiKey } from './runwayApi.js';
import { deleteFalRequestPayloads, resolveFalApiKey } from './falQueue.js';
import { deleteHiggsfieldRequest, resolveHiggsfieldApiKey } from './higgsfieldApi.js';
import { getSettings } from './settings.js';
import { getHistoryItem, mutateVideoHistory } from './videoGen/history.js';
import { editImageSidecar, readImageSidecar } from './imageGen/sidecarStore.js';

const PROVIDERS = {
  runway: {
    label: 'Runway', idField: 'runwayTaskId', deletedField: 'runwayDeletedAt', resolveKey: resolveRunwayApiKey,
    remove: (apiKey, id) => deleteRunwayTask({ apiKey, taskId: id }),
  },
  fal: {
    label: 'fal.ai', idField: 'falRequestId', deletedField: 'falDeletedAt', resolveKey: resolveFalApiKey,
    remove: (apiKey, id) => deleteFalRequestPayloads({ apiKey, requestId: id }),
  },
  higgsfield: {
    label: 'Higgsfield', idField: 'higgsfieldRequestId', deletedField: 'higgsfieldDeletedAt', resolveKey: resolveHiggsfieldApiKey,
    remove: (apiKey, id) => deleteHiggsfieldRequest({ apiKey, requestId: id }),
  },
};

export const shouldDeleteAfterDownload = (settings, provider) => settings?.imageGen?.[provider]?.deleteAfterDownload === true;

function providerFor(id) {
  const provider = PROVIDERS[id];
  if (!provider) throw new ServerError(`Unknown hosted provider: ${id}`, { status: 400, code: 'VALIDATION_ERROR' });
  return provider;
}

// Open gallery/history views refetch the record, so the deleted stamp shows without a reload.
function announceChanged(kind, id) {
  void import('./peerSyncEventBus.js')
    .then((m) => m.emitMediaHistoryChanged({ kind, op: 'upsert', ids: [id] }))
    .catch((err) => console.error(`❌ Hosted-copy change announce failed: ${err.message}`));
}

async function removeHosted(provider, record, apiKey) {
  if (!record) throw new ServerError('Not found', { status: 404, code: 'NOT_FOUND' });
  const remoteId = record[provider.idField];
  if (typeof remoteId !== 'string' || !remoteId) {
    throw new ServerError(`This render has no recorded ${provider.label} request`, { status: 400, code: 'NO_HOSTED_REQUEST' });
  }
  const key = apiKey || provider.resolveKey(await getSettings());
  if (!key) throw new ServerError(`No ${provider.label} API key configured`, { status: 400, code: 'PROVIDER_NOT_CONFIGURED' });
  await provider.remove(key, remoteId);
  return new Date().toISOString();
}

export async function deleteVideoHostedCopy(providerId, id, { apiKey } = {}) {
  const provider = providerFor(providerId);
  const deletedAt = await removeHosted(provider, await getHistoryItem(id), apiKey);
  await mutateVideoHistory((history) => {
    const row = history.find((h) => h.id === id);
    if (row) row[provider.deletedField] = deletedAt;
    return history;
  });
  announceChanged('video', id);
  return { ok: true, deletedAt };
}

export async function deleteImageHostedCopy(providerId, filename, { apiKey } = {}) {
  const provider = providerFor(providerId);
  const deletedAt = await removeHosted(provider, (await readImageSidecar(filename)).metadata, apiKey);
  await editImageSidecar(filename, (sidecar) => {
    sidecar[provider.deletedField] = deletedAt;
    return true;
  });
  announceChanged('image', filename);
  return { ok: true, deletedAt };
}

/** Best-effort removal once the output is saved locally; the render already succeeded, so never throws. */
export async function autoDeleteHostedCopy(providerId, kind, id, { apiKey, settings } = {}) {
  try {
    if (!shouldDeleteAfterDownload(settings ?? await getSettings(), providerId)) return false;
    await (kind === 'image' ? deleteImageHostedCopy : deleteVideoHostedCopy)(providerId, id, { apiKey });
    console.log(`🧹 Removed ${providerFor(providerId).label} copy of ${kind} [${String(id).slice(0, 8)}] after download`);
    return true;
  } catch (err) {
    console.error(`❌ ${providerId} delete-after-download failed for ${kind} [${String(id).slice(0, 8)}]: ${err?.message || err}`);
    return false;
  }
}
