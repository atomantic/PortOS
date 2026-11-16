/**
 * sync.softDelete.test.js
 *
 * sync.js tombstones, peer-sync merge and tombstone GC (soft-delete). Split from universeBuilder.test.js (#16214); shared
 * mocks and fixtures live in universeBuilder.testFixtures.js.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { rmSync } from "fs";

// vi.mock factories are hoisted above imports; the shared fixtures module is
// loaded the same way.
const h = await vi.hoisted(() => import("./universeBuilder.testFixtures.js"));

vi.mock("../../lib/fileUtils.js", (importOriginal) => h.fileUtilsFactory(importOriginal));
vi.mock("../../lib/conflictJournal.js", (importOriginal) => h.conflictJournalFactory(importOriginal));
vi.mock("../instances.js", () => h.instancesFactory());
vi.mock("../sharing/peerSync.js", () => h.peerSyncFactory());
vi.mock("crypto", () => h.cryptoFactory());

const { TEST_DATA_ROOT, writeCounter, baseHashEvictionSequence, seedWorld } = h;
const svc = await import("../universeBuilder.js");
const { naturalUniverseVisualProfile } = await import("../../lib/universeVisualProfile.js");
const cj = await import("../../lib/conflictJournal.js");
const { recordEvents, registerSubscriptionAdapter, __resetSubscriptionAdapter } = await import("../sharing/recordEvents.js");

describe("universeBuilder service", () => {
  beforeEach(() => {
    h.resetFixtures(cj);
  });

  // A test that registers a subscription-adapter double must not leak it into
  // later tests even when its assertions fail mid-body.
  afterEach(() => {
    __resetSubscriptionAdapter();
  });

  describe("soft-delete (tombstones for peer sync)", () => {
    it("deleteUniverse soft-deletes (record stays on disk with deleted=true)", async () => {
      const w = await seedWorld();
      await svc.deleteUniverse(w.id);
      // listUniverses hides it.
      expect(await svc.listUniverses()).toEqual([]);
      // includeDeleted exposes the tombstone with deletedAt + bumped updatedAt.
      const all = await svc.listUniverses({ includeDeleted: true });
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ id: w.id, deleted: true });
      expect(all[0].deletedAt).toBeTruthy();
      expect(all[0].updatedAt).toBe(all[0].deletedAt);
    });

    it("countUniverses excludes tombstones and agrees with listUniverses().length", async () => {
      // countUniverses is the cheap tally the character skill registry reads instead
      // of materializing every record + the run history (#2729). Pin it against
      // listUniverses so the two can never disagree — the specific bug a naive
      // listIds().length would introduce is counting tombstones, since listIds()
      // returns live + ephemeral + tombstones and leaves filtering to the service.
      expect(await svc.countUniverses()).toBe(0);

      const live = await seedWorld();
      const doomed = await seedWorld({ name: "Doomed World" });
      expect(await svc.countUniverses()).toBe(2);
      expect(await svc.countUniverses()).toBe((await svc.listUniverses()).length);

      await svc.deleteUniverse(doomed.id);
      // The tombstone is still ON DISK (soft delete) — listIds() would still see it.
      expect(await svc.listUniverses({ includeDeleted: true })).toHaveLength(2);
      // ...but it must NOT be counted.
      expect(await svc.countUniverses()).toBe(1);
      expect(await svc.countUniverses()).toBe((await svc.listUniverses()).length);
      expect((await svc.listUniverses()).map((u) => u.id)).toEqual([live.id]);

      // includeDeleted mirrors listUniverses's own option, tombstones and all.
      expect(await svc.countUniverses({ includeDeleted: true }))
        .toBe((await svc.listUniverses({ includeDeleted: true })).length);
    });

    it("listUniverseStyles excludes tombstones", async () => {
      const live = await seedWorld();
      const doomed = await seedWorld({ name: "Doomed World" });
      expect((await svc.listUniverseStyles()).map((u) => u.id).sort())
        .toEqual([live.id, doomed.id].sort());

      await svc.deleteUniverse(doomed.id);
      expect((await svc.listUniverseStyles()).map((u) => u.id)).toEqual([live.id]);
    });

    it("getUniverse returns 404 for tombstoned, includeDeleted exposes it", async () => {
      const w = await seedWorld();
      await svc.deleteUniverse(w.id);
      await expect(svc.getUniverse(w.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
      const tombstone = await svc.getUniverse(w.id, { includeDeleted: true });
      expect(tombstone).toMatchObject({ id: w.id, deleted: true });
    });

    it("updateUniverse on a tombstoned record throws 404 (no zombie edits)", async () => {
      const w = await seedWorld();
      await svc.deleteUniverse(w.id);
      await expect(svc.updateUniverse(w.id, { name: "Zombie" })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    });

    it("deleteUniverse on an already-tombstoned record throws 404", async () => {
      const w = await seedWorld();
      await svc.deleteUniverse(w.id);
      await expect(svc.deleteUniverse(w.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("insertUniverseWithId overwrites a tombstoned record (re-import undeletes)", async () => {
      const id = "550e8400-e29b-41d4-a716-44665544abcd";
      await svc.insertUniverseWithId({ id, name: "First" });
      await svc.deleteUniverse(id);
      const restored = await svc.insertUniverseWithId({ id, name: "Restored" });
      expect(restored).toMatchObject({ id, name: "Restored", deleted: false });
      // listUniverses shows it (no longer hidden).
      expect((await svc.listUniverses()).map((u) => u.id)).toContain(id);
    });

    it("insertUniverseWithId resurrection fires emitRecordUpdated + autoSubscribeRecordToAllPeers", async () => {
      const id = "550e8400-e29b-41d4-a716-44665544abcf";
      await svc.insertUniverseWithId({ id, name: "ToResurrect" });
      await svc.deleteUniverse(id);

      const emitSpy = vi.spyOn(recordEvents, "emit");
      // The auto-subscribe flows through the recordEvents subscription
      // adapter (peerSync registers the real impl at boot) — register a
      // test double to observe the call.
      const subscribeSpy = vi.fn().mockResolvedValue([]);
      registerSubscriptionAdapter({ autoSubscribeRecordToAllPeers: subscribeSpy });

      await svc.insertUniverseWithId({ id, name: "Resurrected" });
      // Allow the fire-and-forget adapter call to settle.
      await new Promise((r) => setTimeout(r, 0));

      expect(emitSpy).toHaveBeenCalledWith("updated", { recordKind: "universe", recordId: id });
      expect(subscribeSpy).toHaveBeenCalledWith("universe", id);

      emitSpy.mockRestore();
    });

    it("insertUniverseWithId fresh insert does NOT fire emitRecordUpdated", async () => {
      const id = "550e8400-e29b-41d4-a716-44665544abd0";
      const emitSpy = vi.spyOn(recordEvents, "emit");

      await svc.insertUniverseWithId({ id, name: "Fresh" });

      expect(emitSpy).not.toHaveBeenCalledWith("updated", { recordKind: "universe", recordId: id });
      emitSpy.mockRestore();
    });

    it("insertUniverseWithId still rejects DUPLICATE on a LIVE record", async () => {
      const id = "550e8400-e29b-41d4-a716-44665544abce";
      await svc.insertUniverseWithId({ id, name: "First" });
      await expect(
        svc.insertUniverseWithId({ id, name: "Second" }),
      ).rejects.toMatchObject({ code: svc.ERR_DUPLICATE });
    });

    describe("mergeUniversesFromSync", () => {
      it.each([
        ["equal precision variants", "2026-11-05T12:00:00.000Z", "2026-11-05T12:00:00Z", false],
        ["newer fractional second", "2026-11-05T12:00:00Z", "2026-11-05T12:00:00.500Z", true],
        ["equal timezone offsets", "2026-11-05T12:00:00Z", "2026-11-05T13:00:00+01:00", false],
        ["invalid remote timestamp", "2026-11-05T12:00:00Z", "not-a-date", false],
        ["invalid local timestamp", "not-a-date", "2026-11-05T12:00:00Z", true],
      ])("LWW compares instants for %s", async (_case, localTs, remoteTs, remoteWins) => {
        const local = { id: "world-lww", name: "Local", createdAt: "2026-01-01T00:00:00Z", updatedAt: localTs };
        await svc.mergeUniversesFromSync([local]);

        const result = await svc.mergeUniversesFromSync([{ ...local, name: "Remote", updatedAt: remoteTs }]);

        expect(result).toEqual({ applied: remoteWins, count: remoteWins ? 1 : 0 });
        expect(await svc.getUniverse(local.id)).toMatchObject({ name: remoteWins ? "Remote" : "Local", updatedAt: remoteWins ? remoteTs : localTs });
      });

      it("skips a peer record with an invalid id without aborting the batch", async () => {
        const good = await seedWorld();
        const editTs = new Date(Date.now() + 60_000).toISOString();
        // A malformed-id record (slash → outside the store allowlist) sits
        // BEFORE a valid edit in the same batch. The bad one must be skipped,
        // not throw and drop the valid edit after it.
        const r = await svc.mergeUniversesFromSync([
          { id: "bad/id", name: "Evil", updatedAt: editTs },
          { ...good, name: "Edited", updatedAt: editTs },
        ]);
        expect(r.applied).toBe(true);
        expect(r.count).toBe(1); // only the valid record applied
        expect((await svc.getUniverse(good.id)).name).toBe("Edited");
        await expect(svc.getUniverse("bad/id", { includeDeleted: true }))
          .rejects.toMatchObject({ code: "NOT_FOUND" });
      });

      it("applies an inbound soft-delete from a peer", async () => {
        const w = await seedWorld();
        const tombstoneTs = new Date(Date.now() + 60_000).toISOString();
        const r = await svc.mergeUniversesFromSync([{
          ...w,
          deleted: true,
          deletedAt: tombstoneTs,
          updatedAt: tombstoneTs,
        }]);
        expect(r).toEqual({ applied: true, count: 1 });
        await expect(svc.getUniverse(w.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
        const tombstone = await svc.getUniverse(w.id, { includeDeleted: true });
        expect(tombstone.deleted).toBe(true);
      });

      it("LWW: an inbound edit with later updatedAt wins over a local tombstone", async () => {
        const w = await seedWorld();
        await svc.deleteUniverse(w.id);
        const editTs = new Date(Date.now() + 60_000).toISOString();
        const r = await svc.mergeUniversesFromSync([{
          ...w,
          name: "Edited After Delete",
          deleted: false,
          deletedAt: null,
          updatedAt: editTs,
        }]);
        expect(r.applied).toBe(true);
        // Edit wins — record is live again with the new name.
        const live = await svc.getUniverse(w.id);
        expect(live).toMatchObject({ name: "Edited After Delete", deleted: false });
      });

      it("LWW: an inbound tombstone with later updatedAt wins over a local edit", async () => {
        const w = await seedWorld();
        const tombstoneTs = new Date(Date.now() + 60_000).toISOString();
        const r = await svc.mergeUniversesFromSync([{
          ...w,
          deleted: true,
          deletedAt: tombstoneTs,
          updatedAt: tombstoneTs,
        }]);
        expect(r.applied).toBe(true);
        await expect(svc.getUniverse(w.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
      });

      it("delete transition via sync drops orphan runs (mirrors local-delete contract)", async () => {
        const w = await seedWorld();
        await svc.recordRun({
          id: "run-sync-1",
          universeId: w.id,
          collectionId: "col-x",
          jobIds: ["j1"],
          promptCount: 1,
        });
        expect(await svc.listRuns(w.id)).toHaveLength(1);
        const tombstoneTs = new Date(Date.now() + 60_000).toISOString();
        await svc.mergeUniversesFromSync([{
          ...w,
          deleted: true,
          deletedAt: tombstoneTs,
          updatedAt: tombstoneTs,
        }]);
        expect(await svc.listRuns(w.id)).toEqual([]);
      });

      it("inbound tombstone for a NEVER-SEEN universe is accepted without firing the cascade (no orphan teardown for nothing)", async () => {
        // Regression: the no-local branch previously included tombstones in
        // `transitionedToDeleted`, firing `emitRecordDeleted` + the orphan
        // cascade for a record we never had. Now the no-local branch accepts
        // the record silently — the cascade only fires on real local
        // transitions (deleted=false → deleted=true).
        const ghostId = "550e8400-0000-0000-0000-000000000999";
        const ts = new Date().toISOString();
        const r = await svc.mergeUniversesFromSync([{
          id: ghostId,
          name: "Ghost",
          deleted: true,
          deletedAt: ts,
          updatedAt: ts,
        }]);
        expect(r).toEqual({ applied: true, count: 1 });
        // Tombstone is on disk via includeDeleted.
        const all = await svc.listUniverses({ includeDeleted: true });
        expect(all.find((u) => u.id === ghostId)).toMatchObject({ deleted: true });
      });

      it("delete transition via sync runs cascade — unlinks media collections", async () => {
        const collections = await import("../mediaCollections.js");
        const w = await seedWorld();
        const linked = await collections.findOrCreateCollectionByName({
          name: collections.universeCollectionNameFor(w.name),
          universeId: w.id,
        });
        expect(linked.universeId).toBe(w.id);
        const tombstoneTs = new Date(Date.now() + 60_000).toISOString();
        await svc.mergeUniversesFromSync([{
          ...w,
          deleted: true,
          deletedAt: tombstoneTs,
          updatedAt: tombstoneTs,
        }]);
        const fresh = await collections.getCollection(linked.id);
        expect(fresh.universeId).toBeNull();
      });

      it("local-ephemeral universes are IMMUNE to inbound merges (peer edits + tombstones both refused)", async () => {
        // The user marks a universe ephemeral to fork it private. A peer
        // that still has the pre-ephemeral version (or has a reverse
        // subscription) must not be able to overwrite local content or
        // trigger an orphan cascade by deleting their copy.
        const w = await seedWorld();
        await svc.updateUniverse(w.id, { ephemeral: true });
        const localBefore = await svc.getUniverse(w.id);
        // Inbound edit with NEWER updatedAt — would normally win via LWW.
        const editTs = new Date(Date.now() + 60_000).toISOString();
        const editResult = await svc.mergeUniversesFromSync([{
          ...w,
          name: "Should Not Land",
          updatedAt: editTs,
        }]);
        expect(editResult.applied).toBe(false);
        const localAfterEdit = await svc.getUniverse(w.id);
        expect(localAfterEdit.name).toBe(localBefore.name);
        expect(localAfterEdit.ephemeral).toBe(true);
        // Inbound tombstone with NEWER updatedAt — would normally tombstone.
        const tombstoneTs = new Date(Date.now() + 120_000).toISOString();
        const deleteResult = await svc.mergeUniversesFromSync([{
          ...w,
          deleted: true,
          deletedAt: tombstoneTs,
          updatedAt: tombstoneTs,
        }]);
        expect(deleteResult.applied).toBe(false);
        const stillLive = await svc.getUniverse(w.id);
        expect(stillLive.deleted).toBeFalsy();
      });

      it("strips inbound `ephemeral` field — peers cannot plant a 'dark' record on the receiver", async () => {
        // The wire never carries `ephemeral`, but a buggy / older / non-
        // conformant peer (or the share-bucket importer's mutator-form
        // path) could ship a record with `ephemeral: true`. The receiver
        // must NOT honor that — it's a local-only marker by contract.
        const ghostId = "550e8400-0000-0000-0000-000000000aaa";
        const ts = new Date().toISOString();
        await svc.mergeUniversesFromSync([{
          id: ghostId,
          name: "Inbound Poison",
          ephemeral: true, // attempt to plant a dark record
          updatedAt: ts,
        }]);
        const inbound = await svc.getUniverse(ghostId);
        expect(inbound.name).toBe("Inbound Poison");
        // Receiver scrubs the field — record is normal-syncable.
        expect(inbound.ephemeral).toBeUndefined();
      });

      it("preserves local styleImageRefs across a remote-wins LWW edit (wire-local probe renders)", async () => {
        // styleImageRefs is stripped from the wire, so an inbound payload never
        // carries it. Without the receive-side restore, sanitizeTemplate would
        // default the missing field to [] and a remote-wins LWW write would
        // clobber this peer's locally-rendered probe images. The local value
        // is authoritative — a peer's edit to OTHER fields must not wipe it.
        const w = await seedWorld();
        await svc.updateUniverse(w.id, { styleImageRefs: ["probe-1.png", "probe-2.png"] });
        const localBefore = await svc.getUniverse(w.id);
        expect(localBefore.styleImageRefs).toEqual(["probe-1.png", "probe-2.png"]);
        // Inbound edit (newer updatedAt, no styleImageRefs — wire-stripped) wins LWW.
        const editTs = new Date(Date.now() + 60_000).toISOString();
        const r = await svc.mergeUniversesFromSync([{
          ...w,
          name: "Remote Edited Name",
          styleImageRefs: undefined, // mirror the wire form (field absent)
          updatedAt: editTs,
        }]);
        expect(r.applied).toBe(true);
        const after = await svc.getUniverse(w.id);
        // Remote name landed…
        expect(after.name).toBe("Remote Edited Name");
        // …but local probe renders survived.
        expect(after.styleImageRefs).toEqual(["probe-1.png", "probe-2.png"]);
      });

      it("preserves the local render pin across a remote-wins LWW edit (#3231 Phase 3)", async () => {
        // imageMode/imageModelId are wire-local like styleImageRefs — a peer's
        // edit to other fields must not clear this machine's pinned backend.
        const w = await seedWorld();
        await svc.updateUniverse(w.id, { imageMode: "agy", imageModelId: "gemini-3.6-flash-low" });
        const editTs = new Date(Date.now() + 60_000).toISOString();
        const r = await svc.mergeUniversesFromSync([{
          ...w,
          name: "Remote Edited Name",
          updatedAt: editTs,
        }]);
        expect(r.applied).toBe(true);
        const after = await svc.getUniverse(w.id);
        expect(after.name).toBe("Remote Edited Name");
        expect(after.imageMode).toBe("agy");
        expect(after.imageModelId).toBe("gemini-3.6-flash-low");
      });

      it("preserves the local moodBoardId when a pre-v9/no-meta sender's edit wins LWW (#4188)", async () => {
        // A behind sender passes the version gate (only AHEAD rejects), and
        // its moodBoardId-unaware sanitizer omitted the field — that omission
        // must not read as a clear.
        const w = await seedWorld();
        await svc.updateUniverse(w.id, { moodBoardId: "mb-local" });
        const editTs = new Date(Date.now() + 60_000).toISOString();
        const r = await svc.mergeUniversesFromSync([
          { ...w, name: "Remote Edited Name", updatedAt: editTs },
        ]); // no senderSchemaVersions — legacy/no-meta sender
        expect(r.applied).toBe(true);
        const after = await svc.getUniverse(w.id);
        expect(after.name).toBe("Remote Edited Name");
        expect(after.moodBoardId).toBe("mb-local");
      });

      it("honors a v9-aware sender's omitted moodBoardId as an explicit clear (#4188)", async () => {
        const w = await seedWorld();
        await svc.updateUniverse(w.id, { moodBoardId: "mb-local" });
        const editTs = new Date(Date.now() + 60_000).toISOString();
        const r = await svc.mergeUniversesFromSync(
          [{ ...w, name: "Remote Cleared", updatedAt: editTs }],
          { senderSchemaVersions: { universes: 9 } },
        );
        expect(r.applied).toBe(true);
        const after = await svc.getUniverse(w.id);
        expect("moodBoardId" in after).toBe(false);
      });

      it("applies a v9-aware sender's moodBoardId over the local link (#4188)", async () => {
        const w = await seedWorld();
        await svc.updateUniverse(w.id, { moodBoardId: "mb-local" });
        const editTs = new Date(Date.now() + 60_000).toISOString();
        const r = await svc.mergeUniversesFromSync(
          [{ ...w, moodBoardId: "mb-remote", updatedAt: editTs }],
          { senderSchemaVersions: { universes: 9 } },
        );
        expect(r.applied).toBe(true);
        const after = await svc.getUniverse(w.id);
        expect(after.moodBoardId).toBe("mb-remote");
      });

      it('preserves production canon when a pre-v10 sender wins an unrelated edit (#5378)', async () => {
        const w = await seedWorld();
        await svc.updateUniverse(w.id, {
          characters: [{
            id: 'chr-1', name: 'A', imageRefs: ['neutral.png', 'profile.png', 'body.png'],
            voiceCanon: { version: 1, description: 'warm low alto', approved: true },
            identityPack: { assets: [{ role: 'neutral', imageRef: 'neutral.png', approved: true }] },
          }],
        });
        const local = await svc.getUniverse(w.id);
        const r = await svc.mergeUniversesFromSync(
          [{ ...local, name: 'Old peer rename', characters: [{ id: 'chr-1', name: 'A', imageRefs: ['neutral.png', 'profile.png', 'body.png'] }], updatedAt: new Date(Date.now() + 60_000).toISOString() }],
          { senderSchemaVersions: { universes: 9 } },
        );
        expect(r.applied).toBe(true);
        const after = await svc.getUniverse(w.id);
        expect(after.characters[0].voiceCanon).toMatchObject({ description: 'warm low alto', approved: true });
        expect(after.characters[0].identityPack.assets).toEqual([{ role: 'neutral', imageRef: 'neutral.png', approved: true }]);
      });

      // Additive fields a behind sender's sanitizer strips (#8414). Each case
      // seeds the field locally, then merges a newer remote that lacks it —
      // from a sender one version behind the field (omission = "no slot",
      // must preserve) and from a sender AT the field's version (omission =
      // the author's clear, must apply).
      const styleReference = {
        id: 'style-ref-example', title: 'Dust-lit ink wash', prompt: 'Granular ink wash',
        imageRefs: ['reference.png'], createdAt: '2026-01-01T00:00:00.000Z',
      };
      const withoutField = (list, field) => list.map(({ [field]: _omit, ...rest }) => rest);
      const legacyFieldCases = [
        {
          field: 'visualProfile', since: 16,
          patch: { visualProfile: naturalUniverseVisualProfile() },
          strip: ({ visualProfile: _omit, ...rest }) => rest,
          read: u => u.visualProfile,
          kept: naturalUniverseVisualProfile(), cleared: undefined,
        },
        {
          field: 'factual', since: 12,
          patch: { factual: true },
          strip: ({ factual: _omit, ...rest }) => rest,
          read: (u) => u.factual,
          kept: true, cleared: undefined,
        },
        {
          field: 'styleReferences', since: 8,
          patch: { styleReferences: [styleReference] },
          strip: (u) => ({ ...u, styleReferences: [] }),
          read: (u) => u.styleReferences,
          kept: [styleReference], cleared: [],
        },
        {
          field: 'character relationshipLinks', since: 6,
          patch: {
            characters: [
              { id: 'chr-1', name: 'A', relationshipLinks: [{ id: 'rel-1', targetCharacterId: 'chr-2', type: 'custom', description: 'rivals' }] },
              { id: 'chr-2', name: 'B' },
            ],
          },
          strip: (u) => ({ ...u, characters: withoutField(u.characters, 'relationshipLinks') }),
          read: (u) => u.characters.find((c) => c.id === 'chr-1').relationshipLinks.map((l) => l.id),
          kept: ['rel-1'], cleared: [],
        },
        {
          field: 'object attachments', since: 7,
          patch: {
            characters: [{ id: 'chr-1', name: 'A' }],
            objects: [{ id: 'obj-1', name: 'Brass Lamp', attachments: [{ id: 'att-1', characterId: 'chr-1', role: 'custom', emotion: 'dread' }] }],
          },
          strip: (u) => ({ ...u, objects: withoutField(u.objects, 'attachments') }),
          read: (u) => u.objects.find((o) => o.id === 'obj-1').attachments.map((a) => a.id),
          kept: ['att-1'], cleared: [],
        },
      ];

      it.each(legacyFieldCases)('preserves $field from a behind sender but honors an at-version clear (#8414)', async ({ since, patch, strip, read, kept, cleared }) => {
        for (const [senderVersion, expected] of [[since - 1, kept], [since, cleared]]) {
          const w = await seedWorld();
          await svc.updateUniverse(w.id, patch);
          const local = await svc.getUniverse(w.id);
          expect(read(local)).toEqual(kept);
          const r = await svc.mergeUniversesFromSync(
            [{ ...strip(local), name: 'Peer rename', updatedAt: new Date(Date.now() + 60_000).toISOString() }],
            { senderSchemaVersions: { universes: senderVersion } },
          );
          expect(r.applied).toBe(true);
          const after = await svc.getUniverse(w.id);
          expect(after.name).toBe('Peer rename');
          expect(read(after)).toEqual(expected);
        }
      });
    });

    describe("pruneTombstonedUniverses", () => {
      it("removes tombstones older than the cutoff and leaves newer ones + live records", async () => {
        const live = await seedWorld();
        const oldTombstone = await seedWorld();
        const oldTombstone2 = await seedWorld();
        const newTombstone = await seedWorld();
        await svc.deleteUniverse(oldTombstone.id);
        await svc.deleteUniverse(oldTombstone2.id);
        await svc.deleteUniverse(newTombstone.id);
        // Backdate both old tombstones' deletedAt directly via merge.
        const oldDeletedAt = new Date(Date.now() - 100_000).toISOString();
        const mergeUpdatedAt = new Date(Date.now() + 10_000).toISOString();
        await svc.mergeUniversesFromSync([
          {
            ...(await svc.getUniverse(oldTombstone.id, { includeDeleted: true })),
            deletedAt: oldDeletedAt,
            updatedAt: mergeUpdatedAt,
          },
          {
            ...(await svc.getUniverse(oldTombstone2.id, { includeDeleted: true })),
            deletedAt: oldDeletedAt,
            updatedAt: mergeUpdatedAt,
          },
        ]);
        await cj.setSyncBaseHash('universe', oldTombstone.id, 'hash-old-a');
        await cj.setSyncBaseHash('universe', oldTombstone2.id, 'hash-old-b');
        await cj.flushBaseHashes();
        writeCounter.baseHash = 0;
        // Serialize the eviction calls without sleeping. Without the batch,
        // each call would finish its own side-store write before the next one.
        baseHashEvictionSequence.enabled = true;

        // Cutoff = now - 50s — old (100s ago) is past, new (just now) is not.
        const cutoff = Date.now() - 50_000;
        const result = await svc.pruneTombstonedUniverses(cutoff);
        expect(result.pruned).toBe(2);
        expect(writeCounter.baseHash).toBe(1);
        const remaining = await svc.listUniverses({ includeDeleted: true });
        const ids = remaining.map((u) => u.id);
        expect(ids).toContain(live.id);
        expect(ids).toContain(newTombstone.id);
        expect(ids).not.toContain(oldTombstone.id);
        expect(ids).not.toContain(oldTombstone2.id);
        cj.__resetBaseHashCacheForTests();
        expect(await cj.getSyncBaseHash('universe', oldTombstone.id)).toBeNull();
        expect(await cj.getSyncBaseHash('universe', oldTombstone2.id)).toBeNull();
      });

      it("keeps tombstones with unparseable deletedAt (conservative)", async () => {
        const w = await seedWorld();
        await svc.deleteUniverse(w.id);
        // Corrupt the deletedAt via merge — this can happen if a peer ships
        // a malformed record. We refuse to prune anything we can't time-stamp.
        await svc.mergeUniversesFromSync([{
          ...(await svc.getUniverse(w.id, { includeDeleted: true })),
          deletedAt: 'not-a-date',
          updatedAt: new Date(Date.now() + 10_000).toISOString(),
        }]);
        const result = await svc.pruneTombstonedUniverses(Date.now() + 60_000_000);
        expect(result.pruned).toBe(0);
        const remaining = await svc.listUniverses({ includeDeleted: true });
        expect(remaining.find((u) => u.id === w.id)).toBeTruthy();
      });

      it("returns { pruned: 0 } for a non-finite cutoff (defensive)", async () => {
        expect(await svc.pruneTombstonedUniverses(NaN)).toEqual({ pruned: 0 });
        expect(await svc.pruneTombstonedUniverses(Infinity)).toEqual({ pruned: 0 });
        expect(await svc.pruneTombstonedUniverses('not-a-number')).toEqual({ pruned: 0 });
      });

      it("rescues a record un-deleted between the id-only candidate scan and the queued delete (race safety, #6851)", async () => {
        // The candidate scan now comes from listTombstoneIdsBefore (a store
        // projection) instead of an out-of-queue listRaw()+filter, but the
        // race it must still lose to is the same one pruneTombstonedUniverses
        // has always guarded against: a concurrent sync un-deleting the record
        // between that scan and the per-id queued re-check.
        const w = await seedWorld();
        await svc.deleteUniverse(w.id);
        const oldDeletedAt = new Date(Date.now() - 100_000).toISOString();
        await svc.mergeUniversesFromSync([{
          ...(await svc.getUniverse(w.id, { includeDeleted: true })),
          deletedAt: oldDeletedAt,
          updatedAt: new Date(Date.now() + 10_000).toISOString(),
        }]);
        const cutoff = Date.now() - 50_000;

        // Hold the record's per-id write queue open BEFORE calling prune, so
        // prune's own queueRecordWrite(w.id, recheck) — issued only after its
        // async candidate scan resolves — is forced to queue BEHIND this held
        // task. Writes directly through the facade (not mergeUniversesFromSync,
        // which would itself re-enter queueRecordWrite for the same id and
        // deadlock against the very task it's called from).
        const s = svc.store();
        let releaseHold;
        const holdGate = new Promise((resolve) => { releaseHold = resolve; });
        const held = s.queueRecordWrite(w.id, async () => {
          await holdGate;
          const current = await s.loadOne(w.id);
          await s.writeRecord(w.id, {
            ...current,
            deleted: false,
            deletedAt: null,
            updatedAt: new Date(Date.now() + 20_000).toISOString(),
          });
        });

        const prunePromise = svc.pruneTombstonedUniverses(cutoff);
        releaseHold();
        await held;
        const result = await prunePromise;

        expect(result.pruned).toBe(0);
        const remaining = await svc.listUniverses({ includeDeleted: true });
        const rescued = remaining.find((u) => u.id === w.id);
        expect(rescued?.deleted).toBe(false);
      });
    });
  });
});

afterAll(() => {
  rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
});
