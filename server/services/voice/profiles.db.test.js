import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { checkHealth, close, ensureSchema, query } from '../../lib/db.js';
import { requireDbOrSkip } from '../../lib/dbTestGate.js';
import { getVoiceProfile, saveProfileBenchmark } from './profiles.js';

const health = await checkHealth().catch(() => ({ connected: false }));
const runDb = requireDbOrSkip('voice profile qualification', health.connected, 'Postgres unavailable');
const id = `voice-test-${randomUUID()}`;

describe.skipIf(!runDb)('voice profile qualification persistence', () => {
  afterAll(async () => {
    await query('DELETE FROM voice_profiles WHERE id = $1', [id]);
    await close();
  });

  it('persists route evidence together and rejects stale revisions', async () => {
    await ensureSchema();
    const profile = {
      id, version: 1, binding: { universeId: id, characterId: 'example-character' },
      label: 'Example Voice', engine: 'piper', kind: 'preset', voiceId: 'piper:example',
      routes: { studio: { enabled: true }, interactive: { enabled: false } },
      approval: { status: 'draft' }, benchmark: null,
    };
    await query(`INSERT INTO voice_profiles (id, universe_id, character_id, approval_status, data)
      VALUES ($1, $1, 'example-character', 'draft', $2::jsonb)`, [id, JSON.stringify(profile)]);
    const renderedAt = new Date().toISOString();
    // Real profiles start with JSON null; the first merge must remain an object.
    await saveProfileBenchmark(profile, {
      renderedAt, profileRevision: 1,
      lines: [{ key: 'identity', text: 'An invented sentence.', filename: 'example.wav', engine: 'piper' }],
    });
    const benchmark = {
      renderedAt, profileRevision: 1, interactiveLatencyMs: 250, similarityScore: null,
      interactiveMeasurement: {
        boundary: 'browser-playing-segmented', synthesisLatencyMs: 100,
        renderRequestLatencyMs: 200, playbackStartupMs: 50, modelRevision: 'example-revision',
      },
    };
    await saveProfileBenchmark(profile, benchmark, { interactive: { enabled: true, maxFirstAudioMs: 900 } });
    expect(await getVoiceProfile(id)).toMatchObject({
      label: 'Example Voice', benchmark,
      routes: { studio: { enabled: true }, interactive: { enabled: true, maxFirstAudioMs: 900 } },
    });
    expect((await getVoiceProfile(id)).benchmark.lines).toMatchObject([{ key: 'identity', filename: 'example.wav' }]);
    await query(`UPDATE voice_profiles SET data = data || '{"version":2,"label":"Revised Voice"}'::jsonb WHERE id = $1`, [id]);
    await expect(saveProfileBenchmark(profile, benchmark, { interactive: { enabled: false } }))
      .rejects.toMatchObject({ code: 'VOICE_PROFILE_BENCHMARK_STALE' });
    expect(await getVoiceProfile(id)).toMatchObject({ version: 2, label: 'Revised Voice', routes: { interactive: { enabled: true } } });
  });
});
