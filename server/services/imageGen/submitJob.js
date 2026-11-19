/**
 * Submit a validated image-generation request to its federated, cloud, local,
 * or synchronous external lane. HTTP parsing and validation stay in the route;
 * this service owns every subsequent orchestration and queueing decision.
 */

import { assertCatalogIdentityWritable } from '../catalogDB/identityAccess.js';
import { ServerError } from '../../lib/errorHandler.js';
import { IMAGE_GEN_MODE } from '../../lib/generationModes.js';
import { REFERENCE_IMAGE_FIELDS } from '../../lib/imageGenValidation.js';
import { buildFederatedMediaRequest } from '../../lib/federatedMediaRequest.js';
import * as imageGen from './index.js';
import { prepareFableLoomImageParams } from './fableLoomParams.js';
import { finishVisualProfileImage } from './finishVisualProfile.js';
import { resolveCloudProviderConfig } from './cloudProviderConfig.js';
import { prepareGenerateParams, quickEditCompositionDigest, resolveLocalImageModel } from './prepareParams.js';
import { previewQuickImageEdit } from './promptPreview.js';
import { assertReviewedReference } from './reviewedReference.js';
import { enqueueJob } from '../mediaJobQueue/index.js';
import { recordUserAction } from '../userActions.js';
import { buildUniverseRunTag } from '../universeRunTag.js';
import { prepareRemoteMediaJob } from '../federatedMedia/remoteSubmission.js';
import { collectRemoteInputAssets } from '../federatedMedia/inputAssets.js';
import { attachNodeImage } from '../fableLoom/records.js';
import { attachGeneratedMedia } from '../catalog/catalogDB.js';
import { catalogEvents } from '../catalog/catalogEvents.js';

// Shape returned for any image-gen job that goes through the mediaJobQueue
// (local + codex). Kept in one place so the enqueue branches stay in sync —
// the client's polling/SSE hooks key off these fields.
export const queuedImageResponse = ({ jobId, position, status, mode, model, mediaProviderPeerId = null }) => ({
  jobId,
  generationId: jobId,
  filename: `${jobId}.png`,
  path: `/data/images/${jobId}.png`,
  mode,
  model,
  status,
  position,
  // Which peer is rendering this, or null for a local/cloud render. The client
  // needs it to label the in-flight card honestly — `mode` is null for a
  // federated render precisely because no local backend is running it.
  mediaProviderPeerId,
});

// Event-only pointer: job id in `target`, never the generation prompt (#5596).
export async function enqueueLoggedImage(job, { source = null } = {}) {
  // Selective section revision (#9011): checked as the LAST step before the
  // actual queue write — every branch that reaches this helper has already
  // done its own staging/provider resolution, so this is as close to the
  // cancel/kickoff race as a request can get. A no-op when the tag carries no
  // revisionId; deferred import since only this rare path needs the revision
  // service's closure.
  if (job.params?.musicVideo?.revisionId) {
    const { assertRevisionOpen } = await import('../musicVideo/revisionService.js');
    await assertRevisionOpen(job.params.musicVideo.projectId, job.params.musicVideo.revisionId, { sceneId: job.params.musicVideo.sceneId, kind: 'image' });
  }
  const queued = await enqueueJob(job);
  try {
    const happenedAt = new Date().toISOString();
    await recordUserAction({
      type: 'media.image.enqueue',
      actor: 'user',
      target: queued.jobId,
      summary: 'enqueued image job',
      payload: { jobId: queued.jobId },
      source,
      happenedAt,
      dedupeKey: `media.image.enqueue:${queued.jobId}`,
    });
  } catch (error) {
    // Ledger is a side effect — the job is already queued.
    console.error(`❌ Failed to record media.image.enqueue: ${error.message}`);
  }
  return queued;
}

// Shared by POST /generate and the music-video shot frame service (#15583).
// `data` is already validated. Uploaded temp paths are returned for callers that own cleanup;
// the HTTP route cleans every upload after dispatch settles. A caller with no uploads
// gets an empty list.
export async function executeImageGenerate(data, files = {}, { source = null } = {}) {
  const finish = (responseBody) => ({ body: responseBody, uploadedTempPaths, params });
  if (data.catalogIngredientId) await assertCatalogIdentityWritable(data.catalogIngredientId);
  const { data: params, mode, settings, uploadedTempPaths } = await prepareGenerateParams({
    data,
    files,
    referenceImageFields: REFERENCE_IMAGE_FIELDS,
  });

  await prepareFableLoomImageParams({ params, mode, settings });

  if (data.quickEdit && (!data.reviewedReferenceDigest || data.reviewedPromptDigest !== await quickEditCompositionDigest({ params, mode, settings }))) {
    throw new ServerError('Image settings or prompt changed. Review the refreshed full prompt before editing.', { status: 409, code: 'REVIEWED_PROMPT_CHANGED' });
  }

  if (data.quickEdit) {
    const sent = await previewQuickImageEdit({ params, mode, settings });
    params.sentPrompt = sent.sentPrompt;
  }

  if (data.reviewedReferenceDigest) {
    if (params.initImagePath || !params.referenceImagePaths?.length || (!data.quickEdit && params.referenceImagePaths.length !== 1) || (!params.mediaProviderPeerId && mode === IMAGE_GEN_MODE.EXTERNAL)) {
      throw new ServerError('Reviewed quick edits require the edited image as the first reference on a supported image backend', { status: 400, code: 'REVIEWED_REFERENCE_UNSUPPORTED' });
    }
    await assertReviewedReference(params.referenceImagePaths[0], data.reviewedReferenceDigest);
    params.reviewedReferenceDigest = data.reviewedReferenceDigest;
  }

  // Resolve an optional universe-collection target into a job tag the
  // completion hook understands. Done server-side so a base-style probe lands
  // in the same "Universe: <name>" bucket as batch renders without the
  // front-end doing any collection bookkeeping. Best-effort: a provisioning
  // failure drops the tag and the render still proceeds (it just won't
  // auto-file) rather than failing the user's generation over a side-effect.
  if (params.universeRun?.universeId) {
    const { universeId, universeName, label, category, entryRef } = params.universeRun;
    // The helper provisions the universe collection (best-effort) and assembles
    // the tag. It preserves `entryRef` even when provisioning fails — the
    // durable `imageRefs[]` append (#1395) must not depend on the gallery
    // collection existing — and returns `undefined` (dropping the tag) only
    // when there's nothing left to do (no collection AND no entryRef).
    params.universeRun = await buildUniverseRunTag({
      universeId,
      universeName,
      label,
      category,
      entryRef,
      errorContext: 'image-gen → universe collection provision failed',
    });
  }

  // Collapse the catalog-attach params into a single job tag the completion
  // hook understands (#1359). Folded into `params` so it rides into both the
  // local and codex `enqueueJob` branches below via `...params`; the raw fields
  // are dropped so persisted job.params carries only the canonical tag.
  if (params.catalogIngredientId) {
    params.catalogAttach = {
      ingredientId: params.catalogIngredientId,
      ...(params.catalogMediaKind ? { kind: params.catalogMediaKind } : {}),
    };
  }
  delete params.catalogIngredientId;
  delete params.catalogMediaKind;

  // Local + codex both go through mediaJobQueue (separate lanes — codex
  // doesn't share MLX). External SD-API stays synchronous: it's a remote
  // call with no local single-flight constraint to absorb. `settings` and
  // `mode` were already resolved above (so the FLUX.2 + local-backend gate
  // could fire before staging any uploads).

  // Federated render (#4348): submit to the selected peer instead of running
  // locally. Checked BEFORE the cloud/local dispatch below — those branches
  // resolve this machine's backends, which a remote render never uses.
  if (params.mediaProviderPeerId) {
    // LoRA weights are the one input that still cannot cross, and it is a
    // decision rather than a gap: a LoRA is a MODEL, not conditioning, and
    // remote model installation is out of scope for federation (ADR
    // docs/decisions/2026-08-22-federated-media-input-assets.md rule 3). Refuse
    // rather than silently dropping it — a render that quietly ignores its LoRA
    // is worse than one that says why.
    if (params.loraFilenames?.length || params.loraPaths?.length) {
      throw new ServerError(
        'A federated media provider renders with the models its own operator installed — LoRA weights do not cross. '
        + 'Render locally, or install the LoRA on the peer and allowlist a model that uses it.',
        { status: 400, code: 'MEDIA_PROVIDER_INPUT_UNSUPPORTED' },
      );
    }
    // Conditioning images DO cross (rule 1), by id: the bytes go up through the
    // provider's authenticated, digest-verified asset endpoint immediately
    // before submission. The marker keeps these LOCAL paths, never the
    // provider-issued ids, so a reconcile after a restart re-stages the same
    // bytes instead of naming staging slots that have since expired.
    const inputAssets = collectRemoteInputAssets('image', params);
    // A peer advertises specific models; it has no notion of 'this caller's
    // default'. Say so rather than letting the wire schema report a bare
    // 'expected string, received undefined' for a field the local path defaults.
    if (!params.modelId) {
      throw new ServerError(
        'A federated render must name the provider model explicitly (modelId)',
        { status: 400, code: 'MEDIA_PROVIDER_MODEL_REQUIRED' },
      );
    }
    // Re-validate against the wire schema here rather than trusting the route
    // schema's overlap with it: this object is what gets persisted and replayed
    // on every reconcile, so it must already be a body the provider accepts.
    const request = buildFederatedMediaRequest({ kind: 'image', params });
    const { peer, remoteMedia } = await prepareRemoteMediaJob({
      peerId: params.mediaProviderPeerId,
      kind: 'image',
      request,
      inputAssets,
    });
    // Drop every field that only means something to a LOCAL dispatch: the
    // routing inputs consumed above, plus the backend selectors this render
    // never uses. The destination tags (universeRun, writersRoom, musicVideo,
    // catalogAttach) deliberately stay — their completion hooks fire off the
    // finished filename and work identically for a federated render.
    const {
      mediaProviderPeerId: _peerId, mediaProviderEngine: _engine,
      mode: _mode, cloudModel: _cloudModel, cloudModelIsShippedDefault: _cloudModelProvenance,
      ...jobParams
    } = params;
    // The prompt and model ride only inside the versioned marker: enqueueJob
    // normalizes any job carrying one into the downgrade-safe shape, so this
    // render cannot be re-run for real by a build rolled back past
    // `remoteMedia`. Contract: services/federatedMedia/routedJobParams.js.
    const queued = await enqueueLoggedImage({
      kind: 'image',
      params: { ...jobParams, remoteMedia },
    }, { source });
    return finish(queuedImageResponse({
      ...queued,
      mode: null,
      model: request.modelId,
      mediaProviderPeerId: peer.id,
    }));
  }

  // `cloudModel` and its provenance flag are dispatcher-level knobs, not
  // provider params — the resolver folds them into the provider's own `model`
  // and `modelIsShippedDefault`, so drop the raw fields before they ride into
  // the persisted job params.
  const cloudModel = params.cloudModel;
  const modelIsShippedDefault = params.cloudModelIsShippedDefault;
  delete params.cloudModel;
  delete params.cloudModelIsShippedDefault;
  const cloud = resolveCloudProviderConfig(settings, mode, { model: cloudModel, modelIsShippedDefault });
  if (cloud) {
    // Reject up-front rather than enqueueing a doomed job — the cloud CLIs are
    // gated behind an explicit toggle each (not every Codex account has access
    // to the image_gen tool, and grok spends the user's Grok quota).
    if (!cloud.enabled) throw cloud.disabledError;
    // `mode` inside jobParams is the queue's discriminator — laneForJob()
    // routes cloud jobs to the parallel cloud lane, and runJob's image branch
    // dispatches to the matching imageGen provider module when it sees it.
    // `cloud.modelId` is the *effective* model so the response metadata reports
    // what actually renders (gpt-6-luna by default) instead of "codex"/null.
    const queued = await enqueueLoggedImage({ kind: 'image', params: { ...cloud.jobParams, ...params } }, { source });
    return finish(queuedImageResponse({ ...queued, mode, model: cloud.modelId }));
  }
  if (mode === IMAGE_GEN_MODE.LOCAL) {
    const { pythonPath: py, selectedModel } = resolveLocalImageModel(settings, params);
    const queued = await enqueueLoggedImage({
      kind: 'image',
      params: {
        ...params,
        pythonPath: py,
        ...(selectedModel?.id ? { modelId: selectedModel.id } : {}),
      },
    }, { source });
    // selectedModel reflects the actual fallback chain resolveLocalImageModel
    // applied (caller modelId → 'dev' → allModels[0]) rather than just the
    // requested id.
    return finish(queuedImageResponse({
      ...queued,
      mode: IMAGE_GEN_MODE.LOCAL,
      model: selectedModel?.id || params.modelId || 'dev',
    }));
  }
  // Selective section revision (#9011): the external/agy lane renders
  // synchronously and never touches enqueueLoggedImage's guard above, so it
  // gets its own check right before the (paid) render call. A no-op when the
  // tag carries no revisionId.
  if (params.musicVideo?.revisionId) {
    const { assertRevisionOpen } = await import('../musicVideo/revisionService.js');
    await assertRevisionOpen(params.musicVideo.projectId, params.musicVideo.revisionId, { sceneId: params.musicVideo.sceneId, kind: 'image' });
  }
  if (params.musicVideo?.sceneId) {
    const { assertCatalogRenderParams } = await import('../musicVideo/clipCastReferences.js');
    await assertCatalogRenderParams(params);
  }
  let result = await imageGen.generateImage(params);
  if (params.visualProfile && result?.filename) result = await finishVisualProfileImage({ result, profile: params.visualProfile, signal: new AbortController().signal });
  if (params.musicVideoProjectId && result?.filename) {
    const { fileIntoMusicVideoCollection } = await import('../musicVideoCollectionHook.js');
    await fileIntoMusicVideoCollection(params.musicVideoProjectId, [{ kind: 'image', ref: result.filename }]);
  }
  if (params.fableLoom && result?.filename) {
    await attachNodeImage(
      params.fableLoom.loomId,
      params.fableLoom.episodeId,
      params.fableLoom.nodeId,
      {
        filename: result.filename,
        jobId: result.generationId,
        visualConditioning: params.visualConditioning,
      },
    );
  }
  if (params.catalogAttach && result?.filename) {
    await attachGeneratedMedia(params.catalogAttach.ingredientId, result.filename, {
      kind: params.catalogAttach.kind || 'reference',
    }).catch(() => {});
    catalogEvents.emit('primitive-changed', { ingredientId: params.catalogAttach.ingredientId });
  }
  return finish(result);
}
