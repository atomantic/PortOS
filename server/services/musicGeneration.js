/**
 * Music generation pipeline — the engine-agnostic "make a song" request shared by
 * the Music studio's `POST /api/music/generate` route and the autonomous Music
 * Video run's local song source (#9473), so the run queues a render in-process
 * instead of calling its own HTTP API.
 *
 * `queueMusicGeneration` takes an already-validated request body (the route's
 * `generateSchema` owns validation), resolves the local engine/model or the
 * federated media provider, and enqueues one audio media job. It returns the
 * enqueue ack immediately; the audio lane renders it and the Music Studio
 * completion hook (`musicStudioHook.js`) lands the WAV on the track.
 */

import { ServerError } from '../lib/errorHandler.js';
import { ENGINES, getEngine } from './pipeline/musicGen.js';
import { listEngineModels } from './audioModels.js';
import {
  FEDERATED_MEDIA_WIRE_VERSION,
  federatedMediaDeniesFeature,
  federatedMediaSupports,
} from '../lib/federatedMediaWire.js';
import { enqueueJob, listJobs } from './mediaJobQueue/index.js';
import { resolveFederatedMediaProvider } from './federatedMediaConsumer.js';
import { getPeers } from './instances.js';
import * as tracks from './tracks/index.js';

const INSTRUMENTAL_ONLY_GUIDANCE = 'Instrumental only. Do not include sung, spoken, chanted, choir, or background vocals. Carry the lead melody with the described instruments or textures.';

/** Queue one audio render. Resolves to `{ jobId, position, status }`. */
export async function queueMusicGeneration(input) {
  // The route's schema applies these defaults; an in-process caller gets them here.
  const body = { instrumentalOnly: false, artistId: '', artist: '', albumId: '', ...input };
  // Validate local destination and duplicate state before any peer probe. A
  // stale track or duplicate request should not generate needless federation
  // traffic, even though the probe itself does not start provider work.
  if (body.trackId) {
    const existing = await tracks.getTrack(body.trackId);
    if (!existing) throw new ServerError('Track not found', { status: 404, code: 'NOT_FOUND' });
  }
  const liveJobs = listJobs({ kind: 'audio' }).filter((job) => job.status === 'queued' || job.status === 'running');
  const duplicate = liveJobs.find((job) => {
    const tag = job.params?.musicStudio;
    return body.trackId ? tag?.trackId === body.trackId : tag && !tag.trackId;
  });
  if (duplicate) {
    throw new ServerError('Music generation is already in progress', {
      status: 409,
      code: 'PIPELINE_MUSIC_BUSY',
      context: { jobId: duplicate.id },
    });
  }

  let engine;
  let repo;
  let remoteMedia;

  if (body.mediaProviderPeerId) {
    const peers = await getPeers();
    const peer = peers.find((candidate) => candidate.id === body.mediaProviderPeerId);
    if (!peer) {
      throw new ServerError('Selected media provider peer was not found', {
        status: 404,
        code: 'MEDIA_PROVIDER_PEER_NOT_FOUND',
      });
    }
    const resolved = await resolveFederatedMediaProvider(peer, {
      kind: 'audio',
      engine: body.engine,
      modelId: body.modelId,
    });
    const capability = resolved.capability;
    if (body.durationMode === 'auto' && !capability.autoDuration) {
      throw new ServerError('Selected remote engine does not support automatic duration', {
        status: 400,
        code: 'MEDIA_PROVIDER_AUTO_DURATION_UNSUPPORTED',
      });
    }
    if (body.durationSec !== undefined
      && ((Number.isFinite(capability.minDurationSec) && body.durationSec < capability.minDurationSec)
        || (Number.isFinite(capability.maxDurationSec) && body.durationSec > capability.maxDurationSec))) {
      throw new ServerError('Requested duration is outside the remote engine limits', {
        status: 400,
        code: 'MEDIA_PROVIDER_DURATION_UNSUPPORTED',
        context: {
          minDurationSec: capability.minDurationSec,
          maxDurationSec: capability.maxDurationSec,
        },
      });
    }
    // Two independent facts, and conflating them is how a lyrical render
    // silently comes back instrumental: `capability.lyrics` says the MODEL
    // sings — the same check the provider's own admission gate makes — while
    // the `lyrics` FEATURE says this PEER'S BUILD carries the words at all.
    // Each failure gets its own message, so a caller who actually sent words is
    // told which half is missing rather than getting a plausible render of the
    // wrong thing. Why absent fails closed lives in federatedMediaSupports.
    if (body.lyrics && !body.instrumentalOnly) {
      if (!capability.lyrics) {
        throw new ServerError(
          'The selected remote model renders instrumental audio only. Pick a lyric-capable model, or render this track locally.',
          { status: 400, code: 'MEDIA_PROVIDER_LYRICS_UNSUPPORTED' },
        );
      }
      if (!federatedMediaSupports(resolved.status, 'lyrics', capability)) {
        // `federatedMediaDeniesFeature` keeps message selection separate from
        // the shared fail-closed gate: a present pre-vocabulary status is also
        // a build-level denial for lyrics, while a missing status is unknown.
        throw new ServerError(
          federatedMediaDeniesFeature(resolved.status, 'lyrics', capability)
            ? 'The selected peer runs a PortOS build that cannot carry lyrics to its provider. Update the peer, or render this track locally.'
            : 'The selected peer is not reporting that it can carry lyrics to its provider. Render this track locally, or pick a lyric-capable peer.',
          { status: 400, code: 'MEDIA_PROVIDER_LYRICS_UNSUPPORTED' },
        );
      }
    }
    engine = {
      id: capability.engine,
      name: capability.engineName,
      // The model's own capability, not the wire's: this drives the render
      // snapshot (`lyricsEnabled`), which records what the engine is, and the
      // guard above already refused the one combination where the two disagree
      // in a way that would change the audio.
      lyrics: capability.lyrics,
    };
    remoteMedia = {
      wireVersion: FEDERATED_MEDIA_WIRE_VERSION,
      peerId: peer.id,
      reconcile: false,
      cancelRequested: false,
      profile: body.remoteMusicProfile,
    };
  } else {
    // Reject an unknown engine explicitly rather than letting getEngine() fall
    // back to the default — a typo/stale client would otherwise render with the
    // wrong local backend. An absent engine still selects the local default.
    if (body.engine !== undefined && !ENGINES[body.engine]) {
      throw new ServerError(`Unknown audio engine: ${body.engine}`, { status: 400, code: 'PIPELINE_MUSIC_UNKNOWN_ENGINE' });
    }
    engine = getEngine(body.engine);

    // Resolve a local user-installed model to its HF repo. Remote models are
    // validated against the peer's exact allowlist and never interpreted as a
    // path or local repository on this machine.
    if (body.modelId) {
      const merged = await listEngineModels(engine.id);
      const picked = merged.find((m) => m.id === body.modelId);
      if (!picked) {
        throw new ServerError(`Unknown model for ${engine.name}: ${body.modelId}`, { status: 400, code: 'PIPELINE_MUSIC_UNKNOWN_MODEL' });
      }
      if (picked.userAdded) repo = picked.repo || picked.id;
    }
  }

  // The lyrics that actually CONDITION this render: what the caller sent for a
  // lyric-aware engine ('' = render without lyrics), nothing for a non-lyric
  // engine. The same value drives the generation call AND the render snapshot,
  // so a render card can never claim conditioning text the audio wasn't built
  // from (an absent-lyrics lyric render is genuinely un-conditioned, not "the
  // track's old words").
  // Make the render-level override explicit in BOTH conditioning inputs. Merely
  // dropping lyrics is not enough when the authored caption itself mentions a
  // vocalist. Keep it idempotent so remixing an instrumental take does not append
  // the same directive repeatedly.
  const usedPrompt = body.instrumentalOnly && !body.prompt.includes(INSTRUMENTAL_ONLY_GUIDANCE)
    ? `${body.prompt}\n\n${INSTRUMENTAL_ONLY_GUIDANCE}`
    : body.prompt;
  const usedLyrics = engine.lyrics && !body.instrumentalOnly ? (body.lyrics ?? '') : '';
  if (remoteMedia) {
    // Lyrics ride the marker, not the top-level params, for the same reason the
    // profile does: `params.lyrics` stays blank so a build rolled back past
    // `remoteMedia` fails closed instead of re-rendering locally (#4683).
    // Omitted when empty so an instrumental remote render submits — and
    // idempotency-hashes — exactly the body a pre-lyrics build did.
    if (usedLyrics) remoteMedia.lyrics = usedLyrics;
    remoteMedia.request = {
      engine: engine.id,
      modelId: body.modelId,
      ...(body.durationSec !== undefined ? { durationSec: body.durationSec } : {}),
      ...(body.durationMode !== undefined ? { durationMode: body.durationMode } : {}),
    };
  }

  const result = await enqueueJob({
    kind: 'audio',
    params: {
      // Keep only the fixed-vocabulary profile and routing request under the
      // versioned remote marker. An older PortOS that does not understand
      // remoteMedia will route this audio job to the local adapter; the empty
      // prompt makes that rollback fail closed before a duplicate local render.
      // New consumers derive the safe provider prompt from the profile.
      prompt: remoteMedia ? '' : usedPrompt,
      lyrics: remoteMedia ? '' : usedLyrics,
      engine: engine.id,
      modelId: body.modelId,
      repo,
      durationSec: body.durationSec,
      durationMode: body.durationMode,
      ...(remoteMedia ? { remoteMedia } : {}),
      musicStudio: {
        trackId: body.trackId || null,
        title: body.title || body.prompt.slice(0, 60),
        artistId: body.artistId,
        artist: body.artist,
        albumId: body.albumId,
        // Keep editable source text distinct from the augmented prompt and
        // empty lyric payload that actually condition an instrumental render.
        authoredPrompt: body.prompt,
        authoredLyrics: engine.lyrics === true ? body.lyrics : undefined,
        lyricsEnabled: engine.lyrics === true,
        lyricsProvided: engine.lyrics === true && body.lyrics !== undefined,
        instrumentalOnly: body.instrumentalOnly,
      },
    },
  });
  return result;
}
