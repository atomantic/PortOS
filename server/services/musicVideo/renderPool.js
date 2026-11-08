/** Project-scoped shot placement. A saved pool narrows existing grants; it never enables one. */
import { ServerError } from '../../lib/errorHandler.js';
import { isPerformanceScene } from '../../lib/musicVideoShotTiming.js';

const refuse = (message, reasons = []) => {
  throw new ServerError(message, { status: 409, code: 'MUSIC_VIDEO_RENDER_POOL_UNAVAILABLE', context: { reasons } });
};

export async function applyProjectRenderPool(body) {
  const { getProject } = await import('./projects.js');
  const project = await getProject(body.musicVideo.projectId);
  if (project?.scenes?.some((s) => s.sceneId === body.musicVideo.sceneId && s.setReference?.greyboxShotId)) {
    if (body.mode === 'ic-ingredients-25') {
      throw new ServerError('Clear the greybox reference before using LTX reference images.',
        { status: 400, code: 'MUSIC_VIDEO_GREYBOX_LTX_REFERENCES_UNSUPPORTED' });
    }
    const { withMusicVideoGreyboxInput } = await import('./greyboxReferences.js');
    body = await withMusicVideoGreyboxInput(body, project);
  }
  const pool = project?.videoSettings?.renderPool;
  // The shot card's Song audio toggle decides for its own render; else the project's generation mode.
  let supplied = typeof body.musicVideo.songAudio === 'boolean'
    ? body.musicVideo.songAudio : project?.videoSettings?.generationMode === 'suppliedAudio';
  // A render song audio cannot ride with (a hosted renderer, continuation, end
  // frames) still renders, silent, and says so, rather than refusing the shot.
  const songAudioBlocker = !supplied ? null
    : body.backend && body.backend !== 'local' ? `${body.backend} cannot take song audio`
      : ((body.mode && !['image', 'a2v'].includes(body.mode)) || body.extendFromVideoId
        || body.lastImageFile || body.keyframes?.length || body.chunks > 1)
        ? 'song audio cannot combine with continuation, end frames, keyframes or chained clips' : null;
  if (songAudioBlocker) {
    console.log(`⏭️ ${songAudioBlocker}; rendering ${body.musicVideo.sceneId} without its song window`);
    supplied = false;
    body = { ...body, musicVideo: { ...body.musicVideo, songAudio: false }, _notice: `Rendered without song audio: ${songAudioBlocker}.` };
  }
  // A production run's own routes decide: a supplied-audio route sends `_suppliedAudio` itself.
  if (body.musicVideo.productionRunId && supplied && !body._suppliedAudio) {
    refuse('This production run was started with Prompt motion; start a new run to use Supplied song audio');
  }
  // Existing projects retain their renderer pins until a pool is saved.
  if (!pool || pool.mode === 'local') {
    if (body.mediaProviderPeerId) refuse('Select a peer in the saved project render pool first');
    return supplied ? { ...body, backend: 'local', mode: 'a2v', _suppliedAudio: true } : body;
  }
  const scene = project.scenes?.find((entry) => entry.sceneId === body.musicVideo.sceneId);
  if (!scene) refuse('The requested scene is no longer in this project');
  if (isPerformanceScene(scene)) refuse('Remote performance lip-sync has not been verified; choose This Mac and a supported lip-sync renderer');
  if (body.musicVideo.productionRunId) {
    // Production runs already carry an immutable backend/model budget pool.
    // Replacing it with this mutable placement policy would violate that grant.
    refuse('Project render pools currently support board-generated shots and revisions; production runs require This Mac');
  }
  if (body.backend && body.backend !== 'local') refuse('Peer pools support local GPU models only; choose Local video');
  if (body.mediaProviderPeerId) refuse('Choose peers in the saved project pool, not in the individual request');
  if (!['image', 'suppliedAudio'].includes(project.videoSettings.generationMode || 'image')) {
    refuse('Audio-reactive LoRA weights cannot cross to peers; use Prompt motion or Supplied song audio');
  }
  if (body.mode && !['image', 'a2v'].includes(body.mode)) refuse('Peer pools do not support video continuation or chain state');
  const suppliedAudio = supplied;
  const requestedMode = suppliedAudio ? 'a2v' : 'image';
  const [{ getPeers }, { resolveFederatedMediaProvider }, { listJobs }] = await Promise.all([
    import('../instances.js'), import('../federatedMediaConsumer.js'), import('../mediaJobQueue/index.js'),
  ]);
  const peers = await getPeers();
  const jobs = listJobs().filter((job) => ['queued', 'running'].includes(job.status));
  const candidates = [];
  const reasons = [];
  if (pool.mode === 'both') {
    const modelId = project.videoSettings.modelId;
    if (!modelId) reasons.push('This Mac: select an explicit local model');
    else {
      const { getLocalVideoRenderCapability } = await import('../federatedMediaProvider.js');
      const capability = await getLocalVideoRenderCapability(modelId);
      if (capability?.ready !== true || capability.hardwareEligible !== true || !capability.memory?.requiredGb
        || capability.memory.requiredGb > capability.memory.freeGb || !capability.inputAssets?.roles?.includes('sourceImage')
        || !capability.supportedModes?.includes(requestedMode)
        || (suppliedAudio && !capability.sourceAudio)) reasons.push('This Mac: model, memory capacity or supplied-audio support is unavailable');
      else candidates.push({ modelId, peerId: null, load: jobs.filter((job) => !job.params?.remoteMedia && !['grok', 'fal', 'reactor', 'runway', 'codex', 'agy'].includes(job.params?.mode)).length });
    }
  }
  // Probe only explicitly selected and already allowlisted peers. Status alone
  // is advisory; prepareRemoteMediaJob and provider admission recheck it.
  for (const selected of pool.peers) {
    try {
      const { capability, status } = await resolveFederatedMediaProvider(peers.find((peer) => peer.id === selected.peerId),
        { kind: 'video', engine: 'local', modelId: selected.modelId });
      if (capability.hardwareEligible !== true || !capability.memory?.requiredGb
        || capability.memory.requiredGb > capability.memory.totalGb || capability.memory.requiredGb > capability.memory.freeGb) {
        throw new Error('Measured memory capacity is insufficient or unknown');
      }
      if (!capability.inputAssets?.roles?.includes('sourceImage')) throw new Error('This model cannot consume the selected frame');
      if (!capability.supportedModes?.includes(requestedMode)) throw new Error('The requested shot mode is unavailable or unknown');
      if (suppliedAudio && (!status.features?.includes('sourceAudio') || !capability.sourceAudio)) throw new Error('Supplied audio is not negotiated');
      if (status.queue.maintenanceHeld !== false) throw new Error('Maintenance state is held or unknown; update the peer');
      const assigned = jobs.filter((job) => job.params?.remoteMedia?.peerId === selected.peerId).length;
      candidates.push({ ...selected, load: Math.max(assigned, status.queue.totalActive) });
    } catch (error) { reasons.push(`${selected.modelId}: ${error.message}`); }
  }
  candidates.sort((a, b) => a.load - b.load); // stable ties follow the saved order
  const selected = candidates[0];
  if (!selected) refuse('No selected render node is eligible; no job was submitted', reasons);
  return { ...body, musicVideo: { ...body.musicVideo, clipReferencesDisabled: true }, backend: 'local', modelId: selected.modelId,
    ...(selected.peerId ? { mediaProviderPeerId: selected.peerId } : {}),
    mode: suppliedAudio ? 'a2v' : 'image',
    _suppliedAudio: suppliedAudio,
    // Chosen once before enqueue; retries keep this exact node/model.
  };
}
