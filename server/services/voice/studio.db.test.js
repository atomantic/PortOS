/** Real PostgreSQL library/assignment round trip; run only via test:db. */
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkHealth, ensureSchema, query, close } from '../../lib/db.js';
import { requireDbOrSkip } from '../../lib/dbTestGate.js';
let root;
vi.mock('../../lib/paths.js', async () => {
  const actual = await vi.importActual('../../lib/paths.js');
  return { ...actual, PATHS: { ...actual.PATHS, get voiceProfiles() { return root; } } };
});
// Exercise the real universe lookup against PG while avoiding the test-only file backend.
vi.mock('../universeBuilder/storeFacade.js', async () => {
  const { readRaw } = await import('../universeBuilder/db.js');
  return { store: () => ({ loadOne: readRaw }) };
});
vi.mock('./aukRuntime.js', () => ({ synthesizeAuk: async () => {
  const wav = Buffer.alloc(48); wav.write('RIFF', 0); wav.write('WAVE', 8);
  return { wav, modelRevision: 'test-auk', latencyMs: 10 };
} }));
const health = await checkHealth().catch(error => ({ connected: false, error: error.message }));
const runDb = requireDbOrSkip('voice/studio.db.test', health.connected, health.error || 'Test database unavailable');
const { createStudioVoice, assignStudioVoice } = await import('./studio.js');
const { listVoiceProfiles, listStudioProfiles, resolveCharacterVoice } = await import('./profiles.js');
const ids = [];
const { writeRaw } = await import('../universeBuilder/db.js');
beforeAll(async () => {
  if (!health.connected) return;
  await ensureSchema();
  root = await mkdtemp(join(tmpdir(), 'voice-studio-db-'));
});
afterAll(async () => {
  if (health.connected && ids.length) await query("DELETE FROM voice_profiles WHERE id = ANY($1::text[]) OR data->>'originProfileId' = ANY($1::text[])", [ids]);
  if (health.connected && ids.length) await query('DELETE FROM universes WHERE id = ANY($1::text[])', [ids]);
  if (root) await rm(root, { recursive: true, force: true });
  await close();
});
describe.runIf(runDb)('Voice Studio database contract', () => {
  it('allows multiple unbound voices and atomically serializes competing assignments', async () => {
    const first = await createStudioVoice({ label: 'Example first', instructions: 'Warm alto', text: 'Hello there.' }); ids.push(first.id);
    const second = await createStudioVoice({ label: 'Example second', instructions: 'Low tenor', text: 'Hello there.' }); ids.push(second.id);
    const page = await listStudioProfiles({ limit: 1 });
    const next = await listStudioProfiles({ limit: 1, cursor: page.nextCursor });
    expect(page.items).toHaveLength(1);
    expect(next.items).toHaveLength(1);
    expect(page.items[0].id).not.toBe(next.items[0].id);
    expect(page.items[0]).not.toHaveProperty('sourceAssets');
    expect(page.items[0]).not.toHaveProperty('inference');
    expect(page.total).toBeGreaterThanOrEqual(2);
    await expect(listStudioProfiles({ cursor: 'not-a-cursor' })).rejects.toMatchObject({ status: 400 });
    await writeRaw(first.id, { id: first.id, name: 'Example universe', schemaVersion: 5, characters: [{ id: 'example-character', name: 'Example character' }], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const target = { universeId: first.id, characterId: 'example-character' };
    const copies = await Promise.all([assignStudioVoice(first.id, target), assignStudioVoice(second.id, target)]);
    const bound = await listVoiceProfiles(target);
    expect(bound).toHaveLength(2);
    expect(bound.filter(profile => profile.approval.status === 'approved')).toHaveLength(1);
    expect(await resolveCharacterVoice(target)).toMatchObject({ source: 'profile', profileId: expect.any(String) });
    expect(copies.map(profile => profile.originProfileId).sort()).toEqual([first.id, second.id].sort());
    expect((await listVoiceProfiles()).filter(profile => ids.includes(profile.id)).every(profile => profile.library && profile.binding.universeId === null)).toBe(true);
  });
});
