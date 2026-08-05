/**
 * End-to-end cover for the deleted-persona tombstone (#3533): a persona the user
 * deletes must stay deleted across a peer sync with a machine that still has it,
 * and the delete must PROPAGATE to that machine rather than merely being
 * defended against locally.
 *
 * Exercises the real disk path (meta.json) with PATHS pointed at a temp dir, so
 * the service write, the merge, and the apply all run.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { rmSync } from 'fs';
import { join } from 'path';
import { createTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

// `digital-twin-sync.js` and `digital-twin-helpers.js` both capture
// PATHS.digitalTwin at module load, so the root is fixed for the whole file and
// per-test isolation comes from wiping the dir + the meta cache in beforeEach.
const tempRoot = createTempDataRoot('portos-dt-persona-tombstone-');
const twinDir = join(tempRoot, 'digital-twin');

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makePathsProxy(actual, {
    dataRoot: tempRoot,
    extraOverrides: (root) => ({ digitalTwin: join(root, 'digital-twin') }),
  });
});

const { createPersona, updatePersona, deletePersona, setActivePersona } = await import('./digital-twin-personas.js');
const { loadMeta, saveMeta, cache } = await import('./digital-twin-meta.js');
const { applyDigitalTwinRemote, getDigitalTwinSnapshot } = await import('./digital-twin-sync.js');

const newPersona = () => createPersona({ name: 'Work', instructions: 'Stay concise and professional.' });

/** The snapshot a peer that still holds the persona would ship. */
const peerSnapshotWith = (persona) => ({ meta: { personas: [persona], deletedPersonas: [] } });

beforeEach(async () => {
  rmSync(twinDir, { recursive: true, force: true });
  cache.meta.data = null;
  cache.meta.timestamp = 0;
  await saveMeta({ version: '1.0.0', documents: [], personas: [], deletedPersonas: [] });
});

afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

describe('digital twin persona tombstones (#3533)', () => {
  it('records a tombstone on delete and keeps the persona deleted through a peer sync', async () => {
    const persona = await newPersona();
    const peer = peerSnapshotWith(persona);

    expect(await deletePersona(persona.id)).toEqual({ deleted: true });
    const afterDelete = await loadMeta();
    expect(afterDelete.personas).toEqual([]);
    expect(afterDelete.deletedPersonas.map((t) => t.id)).toEqual([persona.id]);

    // The peer still has the persona and ships it back — the pre-#3533 bug.
    await applyDigitalTwinRemote(peer);
    expect((await loadMeta()).personas).toEqual([]);

    // …and it stays deleted on every subsequent cycle, not just the first.
    await applyDigitalTwinRemote(peer);
    expect((await loadMeta()).personas).toEqual([]);
  });

  it('ships tombstones in the snapshot so peers can see the delete', async () => {
    const persona = await newPersona();
    await deletePersona(persona.id);
    const { data } = await getDigitalTwinSnapshot();
    expect(data.meta.deletedPersonas.map((t) => t.id)).toEqual([persona.id]);
    expect(data.meta.personas).toEqual([]);
  });

  it("propagates a peer's delete by removing the local persona", async () => {
    const persona = await newPersona();
    await setActivePersona(persona.id);

    const { applied } = await applyDigitalTwinRemote({
      meta: { personas: [], deletedPersonas: [{ id: persona.id, deletedAt: new Date(Date.now() + 60_000).toISOString() }] },
    });

    expect(applied).toBe(true);
    const meta = await loadMeta();
    expect(meta.personas).toEqual([]);
    expect(meta.deletedPersonas.map((t) => t.id)).toEqual([persona.id]);
    // The reaped persona was the active one — the pointer must not dangle.
    expect(meta.settings.activePersonaId).toBeNull();
  });

  it('keeps a persona edited here after another machine deleted it, and drops the stale tombstone', async () => {
    const persona = await newPersona();
    const edited = await updatePersona(persona.id, { instructions: 'Stay concise, professional, and warm.' });

    // The peer's delete predates our edit, so the edit is the user's last word.
    const deletedAt = new Date(Date.parse(edited.updatedAt) - 1_000).toISOString();
    await applyDigitalTwinRemote({ meta: { personas: [], deletedPersonas: [{ id: persona.id, deletedAt }] } });

    const meta = await loadMeta();
    expect(meta.personas.map((p) => p.id)).toEqual([persona.id]);
    expect(meta.deletedPersonas).toEqual([]);
  });

  it('leaves an unrelated persona the peer has alone', async () => {
    const persona = await newPersona();
    await deletePersona(persona.id);

    const peerOnly = { id: '11111111-2222-4333-8444-555555555555', name: 'Casual', instructions: 'Loosen up.', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await applyDigitalTwinRemote({ meta: { personas: [peerOnly], deletedPersonas: [] } });

    expect((await loadMeta()).personas.map((p) => p.id)).toEqual([peerOnly.id]);
  });

  it('does not tombstone an id that was never a persona here', async () => {
    expect(await deletePersona('11111111-2222-4333-8444-666666666666')).toEqual({ deleted: false });
    expect((await loadMeta()).deletedPersonas).toEqual([]);
  });
});
