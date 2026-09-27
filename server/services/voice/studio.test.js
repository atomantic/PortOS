import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let root;
let records;
let statements;
let rejectInsert;
const synthesizeAuk = vi.fn();
const getUniverse = vi.fn();
vi.mock('./aukRuntime.js', () => ({ synthesizeAuk: (...args) => synthesizeAuk(...args) }));
vi.mock('../universeBuilder/crud.js', () => ({ getUniverse: (...args) => getUniverse(...args) }));
vi.mock('../../lib/paths.js', () => ({ PATHS: { get voiceProfiles() { return root; } } }));
async function execute(sql, args = []) {
  statements.push(sql);
  if (sql.includes('INSERT INTO voice_profiles')) {
    if (rejectInsert) throw new Error('database unavailable');
    records.set(args[0], JSON.parse(args[4]));
  }
  if (sql.includes('SELECT data FROM voice_profiles WHERE id')) return { rows: records.has(args[0]) ? [{ data: records.get(args[0]) }] : [] };
  if (sql.includes('UPDATE voice_profiles SET')) {
    for (const [id, p] of records) if (p.binding.universeId === args[0] && p.binding.characterId === args[1] && p.approval.status === 'approved') {
      records.set(id, { ...p, approval: { ...p.approval, status: 'retired' } });
    }
  }
  if (sql.includes('SELECT data FROM voice_profiles')) return { rows: [...records.values()]
    .filter(p => !args.length || (p.binding.universeId === args[0] && p.binding.characterId === args[1])).map(data => ({ data })) };
  return { rows: [] };
}
vi.mock('../../lib/db.js', () => ({ query: (...args) => execute(...args), withTransaction: async fn => {
  const snapshot = new Map(records);
  return fn({ query: execute }).catch(error => { records = snapshot; throw error; });
} }));
const { createStudioVoice, assignStudioVoice } = await import('./studio.js');
const { resolveCharacterVoice } = await import('./profiles.js');
const input = { label: 'Example voice', instructions: 'Warm alto', text: 'Hello there.', seed: 42, genSeconds: 4, pitchSemitones: -2 };
const wav = Buffer.alloc(48);
wav.write('RIFF', 0); wav.write('WAVE', 8);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'voice-studio-test-'));
  records = new Map(); statements = []; rejectInsert = false;
  synthesizeAuk.mockReset().mockResolvedValue({ wav, latencyMs: 3200, modelRevision: 'test-auK' });
  getUniverse.mockReset().mockResolvedValue({ characters: [{ id: 'character-1' }, { id: 'character-2' }] });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('Voice Studio audition and casting workflow', () => {
  it('keeps the auditioned reference reusable and assigns independent snapshots consumed by the character resolver', async () => {
    const library = await createStudioVoice(input);
    expect(library).toMatchObject({ library: true, binding: { universeId: null, characterId: null }, engine: 'auk' });
    expect(await readFile(join(root, library.id, 'source/reference.wav'))).toEqual(wav);
    const assigned = await assignStudioVoice(library.id, { universeId: 'universe-1', characterId: 'character-1' });
    const second = await assignStudioVoice(library.id, { universeId: 'universe-1', characterId: 'character-2', enableInteractive: true });
    expect(await resolveCharacterVoice({ universeId: 'universe-1', characterId: 'character-1', route: 'interactive' })).toMatchObject({ source: 'project-default' });
    expect(await resolveCharacterVoice({ universeId: 'universe-1', characterId: 'character-2', route: 'interactive' })).toMatchObject({ profileId: second.id });
    expect(assigned.id).not.toBe(second.id);
    expect(assigned.originProfileId).toBe(library.id);
    expect(await readFile(join(root, assigned.id, 'source/reference.wav'))).toEqual(wav);
    expect(await resolveCharacterVoice({ universeId: 'universe-1', characterId: 'character-1' }))
      .toMatchObject({ source: 'profile', profileId: assigned.id, voiceId: library.voiceId });
    expect(records.get(library.id).binding).toEqual({ universeId: null, characterId: null });
    expect(statements.some(sql => sql.includes('pg_advisory_xact_lock'))).toBe(true);
  });
  it('does not publish failed or invalid auditions', async () => {
    synthesizeAuk.mockRejectedValueOnce(new Error('not installed'));
    await expect(createStudioVoice(input)).rejects.toThrow('not installed');
    synthesizeAuk.mockResolvedValueOnce({ wav: Buffer.from('not audio') });
    await expect(createStudioVoice(input)).rejects.toThrow('valid WAV');
    expect(records.size).toBe(0);
    expect(await readdir(root)).toEqual([]);
  });
  it('preserves the prior approved assignment and removes staged files if replacing it fails', async () => {
    const library = await createStudioVoice(input);
    const assigned = await assignStudioVoice(library.id, { universeId: 'universe-1', characterId: 'character-1' });
    rejectInsert = true;
    await expect(assignStudioVoice(library.id, { universeId: 'universe-1', characterId: 'character-1' })).rejects.toThrow('database unavailable');
    expect(records.get(assigned.id).approval.status).toBe('approved');
    expect((await readdir(root)).sort()).toEqual([library.id, assigned.id].sort());
  });
  it('rejects a deleted character before creating any assignment', async () => {
    const library = await createStudioVoice(input);
    await expect(assignStudioVoice(library.id, { universeId: 'universe-1', characterId: 'missing' })).rejects.toThrow('existing character');
    expect(records.size).toBe(1);
  });
});
