import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PATHS } from '../../lib/paths.js';
import { atomicWrite, ensureDir, rmGuarded } from '../../lib/fileCore.js';
import { readJSONFile } from '../../lib/jsonIo.js';
import { canonicalStringify } from '../../lib/objects.js';
import { isPathInsideDir } from '../../lib/pathSafety.js';
import { createZip } from '../../lib/zipWriter.js';
import { maintenance } from '../../lib/maintenanceAdmission.js';
import { ServerError } from '../../lib/errorHandler.js';
import { exportOptionsSchema } from '../../lib/fableLoomValidation.js';
import { computeGraphLayers } from '../../lib/fableLoomGraph.js';
import {
  FABLELOOM_EXPORT_LIMITS, FABLELOOM_EXPORT_SCHEMA_VERSION,
  fableLoomExportAssetRequests, fableLoomExportOccupancy, inspectFableLoomExport,
  inspectFableLoomExportCharacters, projectFableLoomExportManifest, projectFableLoomExportNode,
  selectFableLoomExportVoice,
} from '../../lib/fableLoomExport.js';
import { getUniverse } from '../universeBuilder.js';
import { loadHistory } from '../videoGen/history.js';
import { getLoom } from './records.js';
import { checkExportCancelled, readFableLoomExportSource } from './exportMedia.js';
import { readFableLoomVoiceReference } from './exportVoice.js';
import { createFableLoomMediaCache } from './exportMediaCache.js';
import { fableLoomRunEvents } from './runEvents.js';
import { FABLELOOM_STATIC_PLAYER_FILES } from './staticPlayerFiles.js';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const active = new Map();
const downloads = new Map();
const controllers = new Map();
const completions = new Map();
let admissionTail = Promise.resolve();
let workerTail = Promise.resolve();
const root = () => join(PATHS.data, 'cache', 'fableloom-exports');
const jobDirectory = id => join(root(), id);
const jobFile = id => join(jobDirectory(id), 'job.json');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => canonicalStringify(value) + '\n';
const error = (code, message, status = 422) => new ServerError(message, { status, code });
const missing = () => error('NOT_FOUND', 'Export job not found for this loom.', 404);
const invalidState = () => error('EXPORT_STATE_INVALID', 'Export state is unreadable or from an unsupported version.', 503);
const absentJob = Symbol('absent-export-job');
const save = async job => {
  job.revision = (job.revision || 0) + 1;
  await atomicWrite(jobFile(job.jobId), job);
  fableLoomRunEvents.emit('export', structuredClone(publicJob(job)));
};
function serializeAdmission(action) {
  const pending = admissionTail.then(action);
  admissionTail = pending.catch(() => {});
  return pending;
}
const portableLabel = value => typeof value === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,199}$/.test(value)
  && !/^(file:|[A-Za-z]:)/i.test(value) && !value.includes('://') ? value : null;

function publicJob(job) {
  return {
    loomId: job.loomId, revision: job.revision || 0, jobId: job.jobId, status: job.status, progress: job.progress, findings: job.findings,
    expiresAt: new Date(job.createdAt + FABLELOOM_EXPORT_LIMITS.maxAgeMs).toISOString(),
    ...(job.error ? { error: job.error } : {}),
    ...(job.sizeReport ? { sizeReport: job.sizeReport } : {}),
    ...(job.status === 'completed' ? {
      downloadUrl: `/api/fableloom/${encodeURIComponent(job.loomId)}/export/${job.jobId}/download`,
    } : {}),
  };
}

async function readJob(id, loomId = null) {
  if (!uuid.test(id)) throw missing();
  const job = await readJSONFile(jobFile(id), absentJob, { strict: true, logError: false }).catch(() => {
    throw invalidState();
  });
  if (job === absentJob) return null;
  if (!job || job.version !== 1 || job.jobId !== id || typeof job.loomId !== 'string'
    || !Number.isSafeInteger(job.createdAt)
    || !Number.isFinite(new Date(job.createdAt + FABLELOOM_EXPORT_LIMITS.maxAgeMs).getTime())
    || !Array.isArray(job.findings) || !job.progress
    || ![job.progress.completed, job.progress.total].every(n => Number.isSafeInteger(n) && n >= 0)
    || job.progress.completed > job.progress.total
    || !['queued', 'validating', 'packing', 'completed', 'failed'].includes(job.status)) {
    throw invalidState();
  }
  if (job.status === 'completed' && (!job.sizeReport
    || !['mediaBytes', 'totalBytes', 'archiveBytes', 'mediaFiles'].every(k => Number.isSafeInteger(job.sizeReport[k]) && job.sizeReport[k] >= 0)
    || job.sizeReport.archiveBytes === 0 || job.sizeReport.archiveBytes > FABLELOOM_EXPORT_LIMITS.maxPackageBytes
    || !/^fableloom-[a-f0-9]{16}-v1\.zip$/.test(job.filename))) {
    throw invalidState();
  }
  if (job.status === 'failed' && (typeof job.error?.code !== 'string' || typeof job.error?.message !== 'string')) throw invalidState();
  if (loomId !== null && job.loomId !== loomId) throw missing();
  if (!active.has(id) && !['completed', 'failed'].includes(job.status)) {
    await rmGuarded(join(jobDirectory(id), 'work'), { recursive: true, force: true });
    job.status = 'failed';
    job.error = { code: 'EXPORT_INTERRUPTED', message: 'The server restarted during export. Start a new export.' };
    await save(job);
  }
  return job;
}

async function prune() {
  await ensureDir(root());
  const entries = await readdir(root(), { withFileTypes: true });
  const retained = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !uuid.test(entry.name) || active.has(entry.name)) continue;
    const job = await readJob(entry.name);
    if (!job) throw error('EXPORT_STATE_INVALID', 'An incomplete export directory needs recovery.', 503);
    if (Date.now() - job.createdAt >= FABLELOOM_EXPORT_LIMITS.maxAgeMs && !downloads.has(entry.name)) {
      await rmGuarded(jobDirectory(entry.name), { recursive: true, force: true });
    } else retained.push(job);
  }
  retained.sort((a, b) => a.createdAt - b.createdAt || a.jobId.localeCompare(b.jobId));
  while (retained.length + active.size >= FABLELOOM_EXPORT_LIMITS.maxJobs && retained.length) {
    const index = retained.findIndex(job => !downloads.has(job.jobId));
    if (index < 0) break;
    const [oldest] = retained.splice(index, 1);
    await rmGuarded(jobDirectory(oldest.jobId), { recursive: true, force: true });
  }
  if (active.size + retained.length >= FABLELOOM_EXPORT_LIMITS.maxJobs) {
    throw error('EXPORT_QUEUE_FULL', 'Four exports are queued, running or being downloaded. Wait for one to finish.', 429);
  }
}

function assetProvenance(loom, node, request) {
  const assets = node.playbackAssets;
  const perAsset = assets?.visualConditioningByAsset || {};
  // Rendering a video replaces the node's latest manifest. Image attachment
  // preserves exactly the current still's manifest in the per-asset map.
  const imageConditioning = node.visualConditioning?.capability?.kind === 'image'
    ? node.visualConditioning : Object.values(perAsset).find(m => m?.capability?.kind === 'image');
  const typedVideo = perAsset[request.sourceId]?.capability?.kind === 'video'
    ? perAsset[request.sourceId] : null;
  const hasTypedPlayback = assets?.entryVideoHistoryId || assets?.holdLoopVideoHistoryIds?.length
    || Object.keys(assets?.exitByTransition || {}).length;
  const legacyVideo = !hasTypedPlayback && node.videoHistoryId === request.sourceId
    && node.visualConditioning?.capability?.kind === 'video' ? node.visualConditioning : null;
  const conditioning = request.kind === 'image' ? imageConditioning : typedVideo || legacyVideo;
  const approved = request.kind === 'image' ? node.visualCanon?.storyboardImageApproved === true
    : typeof loom.productionStatus?.deliveryApprovedAt === 'string'
      && Number.isFinite(Date.parse(loom.productionStatus.deliveryApprovedAt));
  const conditioningStatus = ['locked', 'draft', 'degraded'].includes(conditioning?.status)
    ? conditioning.status : 'unknown';
  const draftFlags = [
    ...(!approved ? ['unapproved'] : []),
    ...(conditioningStatus !== 'locked' ? [conditioningStatus] : []),
  ];
  return {
    approved, conditioningStatus, draftFlags,
    provider: portableLabel(conditioning?.render?.provider || conditioning?.capability?.backend),
    model: portableLabel(conditioning?.render?.modelId || conditioning?.capability?.modelId),
    parametersHash: hash(json(conditioning?.render?.parameters || {})),
  };
}

/** Only this store retains media buffers; source-ID caches receive small descriptors. */
function createMediaStore(maxBytes = FABLELOOM_EXPORT_LIMITS.maxPackageBytes) {
  const files = new Map();
  let byteLength = 0;
  return {
    add({ bytes, extension, durationMs }) {
      if (bytes.length > FABLELOOM_EXPORT_LIMITS.maxAssetBytes) {
        throw error('EXPORT_MEDIA_SIZE', 'Prepared media exceeds the 64 MiB asset limit.');
      }
      const sha256 = hash(bytes);
      const file = `media/${sha256}.${extension}`;
      if (!files.has(file)) {
        if (byteLength + bytes.length > maxBytes) {
          throw error('EXPORT_PACKAGE_SIZE', 'Media exceeds the 256 MiB package limit. Export fewer episodes.');
        }
        files.set(file, bytes);
        byteLength += bytes.length;
      }
      return { file, sha256, durationMs, bytes: bytes.length };
    },
    entries: () => files.entries(),
    get byteLength() { return byteLength; },
    get size() { return files.size; },
  };
}

function packageReadme(options) {
  const playerNote = options.includePlayer
    ? `player/index.html is a dependency-free reference player for this package.
Serve the package directory and open that page. It reads manifest.json, plays a
cut through to its next scene, and holds a decision until a choice.`
    : `This package does not include the reference player. Export again with
includePlayer set to add player/index.html.`;
  const characters = options.includeCharacters ? `
characters/<id>.json is included for each canonical cast member: the loom
protagonist, when set, and characters staged on reachable scenes. Each file
carries persona and speech notes, pronunciation anchors, safety/never-say
notes, and play-turn inputs for contract 1.0.0 (prompt id fableloom-play-turn).
Scene prose and choices stay in manifest.json. The reader's message and
conversation stay with your host. Do not send these files to PortOS.
` : `
Character inputs were not included. A later export can add them with
includeCharacters. This package has no persona notes or pronunciation anchors.
`;
  const voice = options.includeVoice ? `
provenance.json "voices" lists approved reference audio at media/<sha256>.<ext>,
with a content hash and portable provenance (approval, consent, license posture,
and voice-canon source policy). Use it only as a reference for your own TTS or
voice engine. It is not an engine adapter, LoRA, transcript, credential, or
PortOS session.
` : `
Voice reference audio was not included. Supply TTS on your own host.
`;
  return `# FableLoom portable package

Package schema: 1.0.0. Playback runtime: 1.0.0 (see runtime-v1.md).

Serve these files on your own static host. PortOS is an authoring tool and is
never the public server, relay, or live resolver for this package. This package
does not grant PortOS access and includes no PortOS URL, credential, or callback.

manifest.json contains the ordered episodes and reachable scene graphs. Media
references name only media/<sha256>.<extension>, with durationMs and loopable.
Entry clips auto-advance cut scenes; decision holds repeat until a valid choice.
Exit clips are optional and keyed by transition id; absent exits cut directly.
Occupancy intervals are milliseconds relative to that packaged clip.

provenance.json records each media use, provider/model, parameter hash, approval
state and draftFlags. An allowDraft export does not certify production approval.
${characters}${voice}
The source profile remuxes H.264/AAC. Web profiles resize without upscaling,
encode H.264/AAC with bitrate caps, normalize the authored audio mix and include
poster PNGs. Explicitly requested WebM alternatives use VP9/Opus. Encoding
profiles, encoder identities and byte counts are recorded in provenance.json.
${playerNote}
Your host owns free-text resolution, TTS and transport, following runtime-v1.md;
no PortOS URL or credential is needed.
`;
}

async function playerEntries() {
  const entries = [];
  for (const name of FABLELOOM_STATIC_PLAYER_FILES) {
    entries.push({
      name: `player/${name}`,
      data: await readFile(new URL(`./static-player/${name}`, import.meta.url)),
    });
  }
  return entries;
}

// Voice profiles live in Postgres. Keep that module off the default export path.
async function loadVoiceProfiles(universeId, characterId) {
  const { listVoiceProfiles } = await import('../voice/profiles.js');
  return listVoiceProfiles({ universeId, characterId });
}

async function inspectContext(job, snapshot, episodes, universe, signal) {
  checkExportCancelled(signal);
  job.status = 'validating';
  job.findings = inspectFableLoomExport(snapshot, episodes, universe);
  const characterProjection = job.options.includeCharacters
    ? inspectFableLoomExportCharacters(snapshot, episodes, universe, { allowDraft: job.options.allowDraft })
    : null;
  if (characterProjection) job.findings.push(...characterProjection.findings);
  const requests = episodes.flatMap(episode => {
    const reachable = computeGraphLayers(episode).depthById;
    return episode.nodes.filter(n => reachable.has(n.id)).flatMap(node => (
      fableLoomExportAssetRequests(node).map(request => ({ ...request, episode, node }))
    ));
  });
  for (const request of requests) {
    const provenance = assetProvenance(snapshot, request.node, request);
    if (!request.sourceId) job.findings.push({
      gate: 'media', severity: 'error', code: 'EXPORT_MEDIA_MISSING',
      episodeId: request.episode.id, nodeId: request.node.id,
      message: `A required ${request.role} asset is missing.`,
    });
    if (provenance.draftFlags.length) job.findings.push({
      gate: 'approval', severity: job.options.allowDraft ? 'warning' : 'error',
      code: 'EXPORT_ASSET_DRAFT', episodeId: request.episode.id, nodeId: request.node.id,
      message: `The ${request.role} asset is unapproved or has draft, degraded or unknown provenance.`,
    });
  }
  const voicePlans = [];
  const media = createMediaStore();
  if (job.options.includeVoice) {
    const universeId = typeof universe?.id === 'string' && universe.id
      ? universe.id
      : (typeof snapshot.universeId === 'string' ? snapshot.universeId : '');
    for (const character of characterProjection?.characters || []) {
      checkExportCancelled(signal);
      let profiles;
      try {
        profiles = await loadVoiceProfiles(universeId, character.id);
      } catch {
        // The driver error can name a socket or query. The finding stays path-free.
        console.error('❌ Approved voice profiles could not be read for a FableLoom export.');
        job.findings.push({
          gate: 'approval', severity: 'error', code: 'EXPORT_VOICE_UNAVAILABLE', characterId: character.id,
          message: `Approved voice profiles could not be read for character "${character.id}".`,
        });
        continue;
      }
      const selection = selectFableLoomExportVoice(profiles, {
        universeId, characterId: character.id, sourcePolicy: character.approval?.sourcePolicy || null,
      });
      if (!selection.ok) {
        job.findings.push({
          gate: selection.gate, severity: 'error', code: selection.code, characterId: character.id,
          message: selection.message,
        });
        continue;
      }
      for (const asset of selection.assets) {
        let bytes;
        try {
          bytes = await readFableLoomVoiceReference(selection.profileId, asset.filename);
        } catch (failure) {
          job.findings.push({
            gate: 'media', severity: 'error',
            code: typeof failure.code === 'string' && failure.code.startsWith('EXPORT_')
              ? failure.code : 'EXPORT_VOICE_REFERENCE_INVALID',
            characterId: character.id,
            message: typeof failure.code === 'string' && failure.code.startsWith('EXPORT_')
              ? failure.message : 'Approved voice reference audio could not be read.',
          });
          continue;
        }
        const sha256 = hash(bytes);
        if (sha256 !== asset.sha256) {
          job.findings.push({
            gate: 'media', severity: 'error', code: 'EXPORT_VOICE_REFERENCE_MISMATCH', characterId: character.id,
            message: `Character "${character.id}" voice reference does not match its recorded content hash.`,
          });
          continue;
        }
        voicePlans.push({
          characterId: character.id,
          ...media.add({ bytes, extension: asset.filename.slice(asset.filename.lastIndexOf('.') + 1).toLowerCase(), durationMs: null }),
          consentConfirmed: asset.consentConfirmed, licensePosture: asset.licensePosture,
          sourcePolicy: character.approval?.sourcePolicy || null,
        });
      }
    }
  }
  return { requests, voicePlans, characterProjection };
}

async function build(job, snapshot, episodes, history, universe, signal) {
  const { requests, voicePlans, characterProjection } = await inspectContext(job, snapshot, episodes, universe, signal);
  if (job.findings.some(f => f.severity === 'error')) {
    throw error('EXPORT_VALIDATION_FAILED', 'Resolve graph, outline, production, media, approval, character or voice findings before exporting.');
  }
  job.status = 'packing';
  job.progress = { completed: 0, total: requests.length };
  await save(job);
  const directory = join(jobDirectory(job.jobId), 'work');
  await ensureDir(directory);
  const cache = new Map();
  const prepare = await createFableLoomMediaCache(join(root(), 'media-cache'), job.options, signal);
  const nodeAssets = new Map();
  const provenance = [];
  for (const request of requests) {
    checkExportCancelled(signal);
    const key = `${request.kind}:${request.sourceId}`;
    let prepared = cache.get(key);
    if (!prepared) {
      const filename = request.kind === 'image' ? request.sourceId : history.find(h => h.id === request.sourceId)?.filename;
      if (!filename) throw error('EXPORT_MEDIA_MISSING', 'A referenced video history item is missing.');
      const bytes = await readFableLoomExportSource(request.kind === 'image' ? PATHS.images : PATHS.videos, filename);
      const result = await prepare(bytes, request.kind, directory);
      prepared = { ...media.add(result), encoding: result.encoding,
        ...(result.poster ? { poster: media.add(result.poster) } : {}),
        ...(result.webm ? { webm: media.add(result.webm) } : {}) };
      cache.set(key, prepared);
    }
    const occupancy = request.kind === 'video' ? fableLoomExportOccupancy(request.node, request.sourceId) : null;
    if (request.node.interactionWindow?.enabled && request.role === 'hold'
      && (!occupancy || !occupancy.safeForLiveVoice)) {
      throw error('EXPORT_OCCUPANCY_UNSAFE', 'Live holds require a verified speech-safe audio occupancy manifest.');
    }
    if (occupancy && (occupancy.durationMs > prepared.durationMs
      || ['characterDialogue', 'music', 'effects'].some(key => occupancy[key].some(i => i.endMs > prepared.durationMs)))) {
      throw error('EXPORT_OCCUPANCY_INVALID', 'An audio occupancy interval exceeds its clip duration.');
    }
    const binding = {
      ...request,
      playback: { file: prepared.file, sha256: prepared.sha256, durationMs: prepared.durationMs,
        loopable: request.role === 'hold', ...(occupancy ? { audioOccupancy: occupancy } : {}),
        ...(prepared.poster ? { poster: prepared.poster } : {}),
        ...(prepared.webm ? { alternatives: [{ ...prepared.webm, type: 'video/webm' }] } : {}) },
    };
    const nodeKey = `${request.episode.id}:${request.node.id}`;
    if (!nodeAssets.has(nodeKey)) nodeAssets.set(nodeKey, []);
    nodeAssets.get(nodeKey).push(binding);
    provenance.push({
      episodeId: request.episode.id, nodeId: request.node.id, role: request.role,
      ...(request.transitionId ? { transitionId: request.transitionId } : {}),
      ...(request.index !== undefined ? { index: request.index } : {}),
      file: prepared.file, sha256: prepared.sha256, bytes: prepared.bytes, encoding: prepared.encoding,
      ...(prepared.poster ? { poster: prepared.poster } : {}),
      ...(prepared.webm ? { webm: prepared.webm } : {}), ...assetProvenance(snapshot, request.node, request),
    });
    job.progress.completed++;
    await save(job);
  }
  const voiceProvenance = voicePlans.map(plan => {
    return {
      characterId: plan.characterId, file: plan.file, sha256: plan.sha256, bytes: plan.bytes,
      approved: true, draftFlags: [], consentConfirmed: plan.consentConfirmed,
      licensePosture: plan.licensePosture, sourcePolicy: plan.sourcePolicy,
    };
  });
  const portos = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8'));
  const manifest = projectFableLoomExportManifest(snapshot, episodes.map(episode => ({
    id: episode.id, number: episode.number, title: episode.title, synopsis: episode.synopsis, startNodeId: episode.startNodeId,
    nodes: episode.nodes.filter(n => nodeAssets.has(`${episode.id}:${n.id}`))
      .map(node => projectFableLoomExportNode(node, snapshot, nodeAssets.get(`${episode.id}:${node.id}`))),
  })), portos.version);
  if (characterProjection) {
    manifest.characters = characterProjection.characters.map(character => ({
      id: character.id, role: character.role, file: `characters/${character.id}.json`,
    }));
  }
  const provenanceDocument = {
    schemaVersion: FABLELOOM_EXPORT_SCHEMA_VERSION,
    assets: provenance,
    ...(characterProjection ? {
      characters: characterProjection.characters.map(character => ({
        id: character.id, file: `characters/${character.id}.json`,
        approved: character.approval.approved, draftFlags: character.approval.draftFlags,
        voiceCanonVersion: character.approval.voiceCanonVersion,
      })),
    } : {}),
    ...(job.options.includeVoice ? { voices: voiceProvenance } : {}),
  };
  const entries = [
    { name: 'manifest.json', data: json(manifest) },
    { name: 'provenance.json', data: json(provenanceDocument) },
    { name: 'README.md', data: packageReadme(job.options) },
    ...(characterProjection ? characterProjection.characters.map(character => ({
      name: `characters/${character.id}.json`, data: json(character),
    })) : []),
    { name: 'runtime-v1.md', data: await readFile(new URL('../../../docs/features/fableloom-runtime-v1.md', import.meta.url)) },
    ...[...media.entries()].map(([name, data]) => ({ name, data })),
    ...(job.options.includePlayer === true ? await playerEntries() : []),
  ].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const totalBytes = entries.reduce((n, e) => n + Buffer.byteLength(e.data), 0);
  if (totalBytes > FABLELOOM_EXPORT_LIMITS.maxPackageBytes) {
    throw error('EXPORT_PACKAGE_SIZE', 'Package exceeds the 256 MiB limit. Export fewer episodes.');
  }
  const archive = createZip(entries);
  if (archive.length > FABLELOOM_EXPORT_LIMITS.maxPackageBytes) {
    throw error('EXPORT_PACKAGE_SIZE', 'ZIP exceeds the 256 MiB limit. Export fewer episodes.');
  }
  checkExportCancelled(signal);
  await atomicWrite(join(jobDirectory(job.jobId), 'package.zip'), archive);
  checkExportCancelled(signal);
  job.filename = `fableloom-${hash(json(manifest)).slice(0, 16)}-v1.zip`;
  job.sizeReport = { mediaBytes: media.byteLength, totalBytes, archiveBytes: archive.length, mediaFiles: media.size };
  job.status = 'completed';
}

async function run(job, context, permit) {
  let settled = false;
  try {
    try {
      await build(job, context.snapshot, context.episodes, context.history, context.universe, controllers.get(job.jobId).signal);
    } catch (failure) {
      job.status = 'failed';
      job.error = failure.code?.startsWith('EXPORT_')
        ? { code: failure.code, message: failure.message }
        : { code: 'EXPORT_MEDIA_INVALID', message: 'A source media file is missing, unreadable or invalid. Check its attached media and start a new export.' };
    }
    if (job.status === 'failed') await rmGuarded(join(jobDirectory(job.jobId), 'package.zip'), { force: true });
    await rmGuarded(join(jobDirectory(job.jobId), 'work'), { recursive: true, force: true });
    await save(job);
    settled = true;
  } finally {
    active.delete(job.jobId);
    controllers.delete(job.jobId);
    completions.delete(job.jobId);
    if (settled) await permit.finish();
    else permit.markUnsettled();
  }
}

/** Read-only gates; the build repeats these against its own immutable snapshot. */
export async function preflightFableLoomExport(loomId, input = {}) {
  const options = exportOptionsSchema.parse(input);
  if (options.includeVoice && !options.includeCharacters) {
    throw error('EXPORT_VOICE_REQUIRES_CHARACTERS', 'Voice export requires character opt-in (includeCharacters).', 400);
  }
  if (options.mediaProfile === 'source' && options.includeWebm) {
    throw error('EXPORT_OPTION_UNSUPPORTED', 'WebM requires a web media profile.', 400);
  }
  const loom = await getLoom(loomId);
  if (!loom) throw error('NOT_FOUND', 'Loom not found.', 404);
  const ids = options.episodeIds ?? loom.episodes.map(e => e.id);
  const episodes = ids.map(id => loom.episodes.find(e => e.id === id));
  if (!episodes.length || episodes.some(e => !e)) throw error('EXPORT_EPISODES_INVALID', 'Select existing episodes from this loom.', 400);
  const universe = loom.universeId ? await getUniverse(loom.universeId) : null;
  const job = { options, findings: [] };
  await inspectContext(job, loom, episodes, universe);
  return { findings: job.findings, canBuild: !job.findings.some(f => f.severity === 'error'),
    episodeIds: ids, options, note: 'Build rechecks gates and source media bytes; preflight does not certify a finished package.' };
}

export async function startFableLoomExport(loomId, input = {}) {
  const options = exportOptionsSchema.parse(input);
  if (options.mediaProfile === 'source' && options.includeWebm) {
    throw error('EXPORT_OPTION_UNSUPPORTED', 'WebM requires a web media profile.', 400);
  }
  if (options.includeVoice && !options.includeCharacters) {
    throw error('EXPORT_VOICE_REQUIRES_CHARACTERS', 'Voice export requires character opt-in (includeCharacters).', 400);
  }
  const jobId = randomUUID();
  const permit = maintenance.admit('media', jobId);
  try {
    const context = await serializeAdmission(async () => {
      const loom = await getLoom(loomId);
      if (!loom) throw error('NOT_FOUND', 'Loom not found.', 404);
      const ids = new Set(options.episodeIds ?? loom.episodes.map(e => e.id));
      if (!ids.size || loom.episodes.filter(e => ids.has(e.id)).length !== ids.size) {
        throw error('EXPORT_EPISODES_INVALID', 'Select existing episodes from this loom.', 400);
      }
      await prune();
      const snapshot = structuredClone(loom);
      const episodes = [...ids].map(id => snapshot.episodes.find(e => e.id === id));
      const sourceHistory = await loadHistory();
      if (!Array.isArray(sourceHistory)) throw error('EXPORT_MEDIA_INVALID', 'Video history is unreadable.');
      const videoIds = new Set(episodes.flatMap(e => e.nodes.flatMap(n => fableLoomExportAssetRequests(n)
        .filter(a => a.kind === 'video').map(a => a.sourceId))));
      const history = sourceHistory.filter(h => h && videoIds.has(h.id)).map(({ id, filename }) => ({ id, filename }));
      const universe = snapshot.universeId ? structuredClone(await getUniverse(snapshot.universeId)) : null;
      const job = { version: 1, jobId, loomId, createdAt: Date.now(), status: 'queued', options,
        progress: { completed: 0, total: 0 }, findings: [] };
      await save(job);
      active.set(jobId, job);
      controllers.set(jobId, new AbortController());
      return { job, snapshot, episodes, history, universe };
    });
    const pending = workerTail.then(() => permit.run(() => run(context.job, context, permit)));
    completions.set(jobId, pending);
    workerTail = pending.catch(() => { console.error('❌ FableLoom export persistence failed; maintenance ownership is retained.'); });
    return { jobId };
  } catch (failure) {
    await permit.finish();
    throw failure;
  }
}

/** Wait for the worker and its children before reporting cancellation as settled. */
export async function cancelFableLoomExport(loomId, jobId) {
  await getFableLoomExport(loomId, jobId);
  controllers.get(jobId)?.abort();
  await completions.get(jobId);
  return getFableLoomExport(loomId, jobId);
}

export async function getFableLoomExport(loomId, jobId) {
  if (!await getLoom(loomId)) throw missing();
  const job = await readJob(jobId, loomId);
  if (!job || job.loomId !== loomId) throw missing();
  if (Date.now() - job.createdAt >= FABLELOOM_EXPORT_LIMITS.maxAgeMs) {
    throw error('EXPORT_EXPIRED', 'This export has expired. Start a new export.', 410);
  }
  return publicJob(job);
}

export async function getFableLoomExportDownload(loomId, jobId) {
  return serializeAdmission(async () => {
    const job = await getFableLoomExport(loomId, jobId);
    if (job.status !== 'completed') throw error('EXPORT_NOT_READY', 'The export has not completed successfully.', 409);
    const [path, base] = await Promise.all([
      realpath(join(jobDirectory(jobId), 'package.zip')).catch(() => null),
      realpath(jobDirectory(jobId)).catch(() => null),
    ]);
    const info = path ? await stat(path).catch(() => null) : null;
    if (!path || !base || !info?.isFile() || !isPathInsideDir(base, path) || info.size !== job.sizeReport.archiveBytes) {
      throw error('EXPORT_ARTIFACT_INVALID', 'The export artifact is unavailable. Start a new export.', 409);
    }
    const stored = await readJob(jobId);
    downloads.set(jobId, (downloads.get(jobId) || 0) + 1);
    let released = false;
    return { path, filename: stored.filename, release: () => {
      if (released) return;
      released = true;
      const remaining = downloads.get(jobId) - 1;
      if (remaining) downloads.set(jobId, remaining);
      else downloads.delete(jobId);
    } };
  });
}

export const __testing = { createMediaStore, drain: async () => { await admissionTail; await workerTail; } };
