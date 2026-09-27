/** Auditioned library voices; assigning creates an immutable character snapshot. */
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { withTransaction } from '../../lib/db.js';
import { ServerError } from '../../lib/errorHandler.js';
import { synthesizeAuk } from './aukRuntime.js';
import { getUniverse } from '../universeBuilder/crud.js';
import { getVoiceProfileRequired, sanitizeVoiceProfile, persistVoiceProfile, profileArtifactDirectory } from './profiles.js';

export async function createStudioVoice({ label, instructions, text, seed = 42, rate = 1, pitchSemitones = 0, genSeconds = 4 }) {
  // No record is published unless the actual model has produced playable audio.
  const result = await synthesizeAuk(text, { instructions, seed, rate, pitchSemitones, genSeconds: genSeconds / rate });
  if (result.wav.length < 44 || result.wav.toString('ascii', 0, 4) !== 'RIFF' || result.wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new ServerError('AuK did not produce valid WAV audio.', { status: 502 });
  }
  const id = randomUUID();
  const directory = profileArtifactDirectory(id);
  await mkdir(join(directory, 'source'), { recursive: true });
  const filename = 'reference.wav';
  const now = new Date().toISOString();
  const profile = sanitizeVoiceProfile({
    id, library: true, label, version: 1, kind: 'designed', engine: 'auk', voiceId: `auk:${id}`,
    modelRevision: result.modelRevision, inference: { instructions, seed, rate, pitchSemitones, genSeconds },
    delivery: { rate: 1 }, // reference already embodies the auditioned pacing
    sourceAssets: [{ filename, transcript: text, sha256: createHash('sha256').update(result.wav).digest('hex'),
      licensePosture: 'generated-original-voice' }],
    routes: { studio: { enabled: true }, interactive: { enabled: false } },
    approval: { status: 'approved', approvedAt: now, benchmarkRevision: 1 },
    benchmark: { renderedAt: now, profileRevision: 1, lines: [{ key: 'preview', text,
      filename: `voice-profiles/${id}/source/${filename}`, latencyMs: result.latencyMs,
      engine: 'auk', modelRevision: result.modelRevision, effectiveControls: result.effectiveControls }] },
    createdAt: now, updatedAt: now,
  });
  return writeFile(join(directory, 'source', filename), result.wav)
    .then(() => persistVoiceProfile(profile))
    .catch(async error => { await rm(directory, { recursive: true, force: true }); throw error; });
}

export async function assignStudioVoice(profileId, { universeId, characterId, enableInteractive = false }) {
  const universe = await getUniverse(universeId);
  if (!universe?.characters?.some(character => character.id === characterId)) {
    throw new ServerError('Choose an existing character in this universe.', { status: 404 });
  }
  const source = await getVoiceProfileRequired(profileId);
  if (source.approval.status !== 'approved' || !['auk', 'piper'].includes(source.engine)) {
    throw new ServerError('Choose an approved, available voice.', { status: 409 });
  }
  const id = randomUUID();
  const directory = profileArtifactDirectory(id);
  await mkdir(join(directory, 'source'), { recursive: true });
  const now = new Date().toISOString();
  const assigned = sanitizeVoiceProfile({ ...source, id, library: false,
    binding: { universeId, characterId }, originProfileId: source.originProfileId || source.id,
    // AuK returns whole clips. Live use is an explicit acceptance of buffered
    // playback, not a claim that it passed the low-latency streaming benchmark.
    routes: { ...source.routes, interactive: source.engine === 'auk'
      ? { enabled: enableInteractive, maxFirstAudioMs: enableInteractive ? 180_000 : 900 }
      : source.routes.interactive },
    benchmark: null, createdAt: now, updatedAt: now,
  });
  const save = async () => {
    for (const asset of source.sourceAssets) await copyFile(
      join(profileArtifactDirectory(source.id), 'source', asset.filename), join(directory, 'source', asset.filename));
    return withTransaction(async client => {
      // Serializes same-character assignments, including when no binding exists yet.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [JSON.stringify([universeId, characterId])]);
      await client.query(`UPDATE voice_profiles SET approval_status = 'retired',
        data = jsonb_set(data, '{approval,status}', '"retired"'::jsonb), updated_at = NOW()
        WHERE universe_id = $1 AND character_id = $2 AND approval_status = 'approved'`, [universeId, characterId]);
      return persistVoiceProfile(assigned, client.query.bind(client));
    });
  };
  return save().catch(async error => { await rm(directory, { recursive: true, force: true }); throw error; });
}
