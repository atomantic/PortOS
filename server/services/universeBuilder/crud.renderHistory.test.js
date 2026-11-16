/**
 * crud.renderHistory.test.js
 *
 * entry ids and render-history mutations. Split from universeBuilder.test.js (#16214); shared
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

const { TEST_DATA_ROOT, seedState } = h;
const svc = await import("../universeBuilder.js");
const cj = await import("../../lib/conflictJournal.js");
const { __resetSubscriptionAdapter } = await import("../sharing/recordEvents.js");

describe("universeBuilder service", () => {
  beforeEach(() => {
    h.resetFixtures(cj);
  });

  // A test that registers a subscription-adapter double must not leak it into
  // later tests even when its assertions fail mid-body.
  afterEach(() => {
    __resetSubscriptionAdapter();
  });

  describe("entry ids + render history", () => {
    it("sanitizeTemplate mints stable ids for variations + composite sheets", async () => {
      const u = await svc.createUniverse({
        name: "Avatars",
        categories: {
          landscapes: { variations: [{ label: "L1", prompt: "p1" }] },
        },
        compositeSheets: [{ kind: "reference_sheet", label: "S1", prompt: "sp" }],
      });
      const v = u.categories.landscapes.variations[0];
      expect(v.id).toMatch(/^var-/);
      expect(v.imageRefs).toEqual([]);
      const sheet = u.compositeSheets[0];
      expect(sheet.id).toMatch(/^sheet-/);
      expect(sheet.imageRefs).toEqual([]);
    });

    it("sanitizeTemplate round-trips existing variation + sheet ids verbatim", async () => {
      await seedState({
        universes: [
          {
            id: "w1",
            name: "X",
            schemaVersion: svc.CURRENT_SCHEMA_VERSION,
            categories: {
              landscapes: {
                kind: "places",
                variations: [{ id: "var-keep-me", label: "V1", prompt: "p1" }],
              },
            },
            compositeSheets: [{ id: "sheet-keep-me", kind: "reference_sheet", label: "S1", prompt: "sp" }],
            createdAt: "2024-01-01T00:00:00Z",
          },
        ],
        runs: [],
      });
      const list = await svc.listUniverses();
      expect(list[0].categories.landscapes.variations[0].id).toBe("var-keep-me");
      expect(list[0].compositeSheets[0].id).toBe("sheet-keep-me");
    });

    it("legacy universe (no variation ids on disk) gets unstable in-memory ids until persisted, then stable after a write", async () => {
      // Plant a pre-PR universe shape with no variation/sheet ids. Reads
      // through readState() mint fresh UUIDs each call because the migration
      // is not persisted there (race-safety against concurrent writers — see
      // readState() docstring). After a no-op updateUniverse() forces a write,
      // ids land on disk and every subsequent read returns the same ones.
      await seedState({
        universes: [
          {
            id: "legacy-universe",
            name: "Legacy",
            schemaVersion: svc.CURRENT_SCHEMA_VERSION,
            categories: {
              landscapes: { kind: "places", variations: [{ label: "L1", prompt: "p1" }] },
            },
            compositeSheets: [],
            createdAt: "2024-01-01T00:00:00Z",
          },
        ],
        runs: [],
      });
      const a = await svc.getUniverse("legacy-universe");
      const b = await svc.getUniverse("legacy-universe");
      expect(a.categories.landscapes.variations[0].id).not.toBe(b.categories.landscapes.variations[0].id);
      // No-op mutator persists the in-memory sanitized shape (the render
      // route uses this to lock in entryRef.id before queueing jobs).
      const persisted = await svc.updateUniverse("legacy-universe", () => ({}));
      const variationIdPersisted = persisted.categories.landscapes.variations[0].id;
      const c = await svc.getUniverse("legacy-universe");
      expect(c.categories.landscapes.variations[0].id).toBe(variationIdPersisted);
      // appendEntryImageRef against the persisted id now succeeds.
      await svc.appendEntryImageRef("legacy-universe", { kind: "variation", categoryKey: "landscapes", id: variationIdPersisted }, "after-persist.png");
      const d = await svc.getUniverse("legacy-universe");
      expect(d.categories.landscapes.variations[0].imageRefs).toEqual(["after-persist.png"]);
    });

    it("needsEntryIdPersist returns true only when raw-disk variations or sheets lack ids", async () => {
      // Mixed fixture: one universe has ids on disk, the other doesn't.
      // The render route uses this helper to skip the no-op write when the
      // universe is already migrated — so already-upgraded records don't
      // bump updatedAt (which would interfere with LWW sync + spuriously
      // emit recordUpdated on every render).
      await seedState({
        universes: [
          {
            id: "fresh",
            name: "Fresh",
            schemaVersion: svc.CURRENT_SCHEMA_VERSION,
            categories: {
              landscapes: { kind: "places", variations: [{ id: "var-on-disk", label: "L", prompt: "p" }] },
            },
            compositeSheets: [{ id: "sheet-on-disk", kind: "reference_sheet", label: "S", prompt: "sp" }],
            createdAt: "2024-01-01T00:00:00Z",
          },
          {
            id: "legacy",
            name: "Legacy",
            schemaVersion: svc.CURRENT_SCHEMA_VERSION,
            categories: {
              landscapes: { kind: "places", variations: [{ label: "L", prompt: "p" }] },
            },
            compositeSheets: [],
            createdAt: "2024-01-01T00:00:00Z",
          },
          {
            id: "legacy-sheet",
            name: "LegacySheet",
            schemaVersion: svc.CURRENT_SCHEMA_VERSION,
            categories: {},
            compositeSheets: [{ kind: "reference_sheet", label: "S", prompt: "sp" }],
            createdAt: "2024-01-01T00:00:00Z",
          },
        ],
        runs: [],
      });
      expect(await svc.needsEntryIdPersist("fresh")).toBe(false);
      expect(await svc.needsEntryIdPersist("legacy")).toBe(true);
      expect(await svc.needsEntryIdPersist("legacy-sheet")).toBe(true);
      expect(await svc.needsEntryIdPersist("does-not-exist")).toBe(false);
    });

    it("appendEntryImageRef appends to a variation's imageRefs by id", async () => {
      const u = await svc.createUniverse({
        name: "Bucket",
        categories: { landscapes: { variations: [{ label: "L1", prompt: "p1" }] } },
      });
      const variationId = u.categories.landscapes.variations[0].id;
      await svc.appendEntryImageRef(u.id, { kind: "variation", categoryKey: "landscapes", id: variationId }, "rendered-1.png");
      await svc.appendEntryImageRef(u.id, { kind: "variation", categoryKey: "landscapes", id: variationId }, "rendered-2.png");
      const updated = await svc.getUniverse(u.id);
      expect(updated.categories.landscapes.variations[0].imageRefs).toEqual(["rendered-1.png", "rendered-2.png"]);
    });

    it("appendEntryImageRef rejects pathy filenames up-front (no queued write)", async () => {
      // A renderer that ever returns a path-laden filename should be
      // rejected at the helper boundary — letting it through would trigger
      // a no-op write (sanitizer strips it later) and pointlessly bump
      // updatedAt + emit recordUpdated.
      const u = await svc.createUniverse({
        name: "PathReject",
        categories: { landscapes: { variations: [{ label: "L1", prompt: "p1" }] } },
      });
      const variationId = u.categories.landscapes.variations[0].id;
      const before = (await svc.getUniverse(u.id)).updatedAt;
      const result1 = await svc.appendEntryImageRef(u.id, { kind: "variation", categoryKey: "landscapes", id: variationId }, "../escape.png");
      const result2 = await svc.appendEntryImageRef(u.id, { kind: "variation", categoryKey: "landscapes", id: variationId }, "sub/file.png");
      const result3 = await svc.appendEntryImageRef(u.id, { kind: "variation", categoryKey: "landscapes", id: variationId }, "..\\windows.png");
      expect(result1).toBe(null);
      expect(result2).toBe(null);
      expect(result3).toBe(null);
      const after = (await svc.getUniverse(u.id)).updatedAt;
      expect(after).toBe(before);
    });

    it("appendEntryImageRef dedupes a same-filename repeat render", async () => {
      const u = await svc.createUniverse({
        name: "Dedupe",
        compositeSheets: [{ kind: "reference_sheet", label: "S1", prompt: "sp" }],
      });
      const sheetId = u.compositeSheets[0].id;
      await svc.appendEntryImageRef(u.id, { kind: "sheet", id: sheetId }, "x.png");
      await svc.appendEntryImageRef(u.id, { kind: "sheet", id: sheetId }, "x.png");
      const updated = await svc.getUniverse(u.id);
      expect(updated.compositeSheets[0].imageRefs).toEqual(["x.png"]);
    });

    it("appendEntryImageRef appends to a canon entry's imageRefs by id", async () => {
      const u = await svc.createUniverse({
        name: "Canon",
        places: [{ id: "set-abc", name: "Library" }],
      });
      await svc.appendEntryImageRef(u.id, { kind: "canon", kindKey: "places", id: "set-abc" }, "place-render.png");
      const updated = await svc.getUniverse(u.id);
      expect(updated.places[0].imageRefs).toContain("place-render.png");
    });

    it("appendEntryImageRef is a no-op when entry id no longer exists", async () => {
      const u = await svc.createUniverse({ name: "Gone" });
      const result = await svc.appendEntryImageRef(u.id, { kind: "variation", categoryKey: "landscapes", id: "var-missing" }, "x.png");
      // The mutator returns null → updateUniverse skips the write and resolves
      // with the unchanged record. Either shape is fine; we just want no throw.
      expect(result).toBeTruthy();
    });

    it("stale literal-object PATCH does not clobber server-stamped imageRefs (variations)", async () => {
      const u = await svc.createUniverse({
        name: "Stale",
        categories: { landscapes: { variations: [{ label: "L1", prompt: "p1" }] } },
      });
      const variationId = u.categories.landscapes.variations[0].id;
      // Server stamps a render history while the client is editing.
      await svc.appendEntryImageRef(u.id, { kind: "variation", categoryKey: "landscapes", id: variationId }, "fresh.png");
      // Client (loaded BEFORE the render landed) PATCHes a label edit with
      // an empty imageRefs list. The stale-guard must preserve the freshly
      // appended filename.
      await svc.updateUniverse(u.id, {
        categories: {
          landscapes: {
            kind: "places",
            variations: [{ id: variationId, label: "L1 renamed", prompt: "p1", imageRefs: [] }],
          },
        },
      });
      const final = await svc.getUniverse(u.id);
      const v = final.categories.landscapes.variations[0];
      expect(v.label).toBe("L1 renamed");
      expect(v.imageRefs).toEqual(["fresh.png"]);
    });

    it("stale literal-object PATCH does not clobber server-stamped imageRefs (composite sheets)", async () => {
      const u = await svc.createUniverse({
        name: "StaleSheet",
        compositeSheets: [{ kind: "reference_sheet", label: "S1", prompt: "sp" }],
      });
      const sheetId = u.compositeSheets[0].id;
      await svc.appendEntryImageRef(u.id, { kind: "sheet", id: sheetId }, "sheet.png");
      await svc.updateUniverse(u.id, {
        compositeSheets: [{ id: sheetId, kind: "reference_sheet", label: "S1 renamed", prompt: "sp" }],
      });
      const final = await svc.getUniverse(u.id);
      expect(final.compositeSheets[0].label).toBe("S1 renamed");
      expect(final.compositeSheets[0].imageRefs).toEqual(["sheet.png"]);
    });

    it("stale at-cap PATCH detects rotation via tail mismatch (variations)", async () => {
      // Seed a variation whose imageRefs is already at the cap. A server-side
      // append rotates the list (drops oldest, pushes newest) — lengths stay
      // equal, so the stale-PATCH guard must compare the tail element, not
      // just the length.
      const cap = svc.IMAGE_REFS_PER_ENTRY_MAX;
      const capRefs = Array.from({ length: cap }, (_, i) => `r${i}.png`);
      const u = await svc.createUniverse({
        name: "Capped",
        categories: { landscapes: { variations: [{ label: "L1", prompt: "p1", imageRefs: capRefs }] } },
      });
      const variationId = u.categories.landscapes.variations[0].id;
      // Server appends a new render — list rotates (r0.png drops off, fresh.png appended).
      await svc.appendEntryImageRef(u.id, { kind: "variation", categoryKey: "landscapes", id: variationId }, "fresh.png");
      // Stale client (loaded BEFORE the rotation) PATCHes with the
      // pre-rotation list — same length, but tail is r{cap-1}.png instead of
      // fresh.png. Without the tail check, the stale list would clobber the
      // server-stamped fresh.png.
      await svc.updateUniverse(u.id, {
        categories: {
          landscapes: {
            kind: "places",
            variations: [{ id: variationId, label: "L1 renamed", prompt: "p1", imageRefs: capRefs }],
          },
        },
      });
      const final = await svc.getUniverse(u.id);
      const v = final.categories.landscapes.variations[0];
      expect(v.label).toBe("L1 renamed");
      // Tail should still be fresh.png (the server-stamped newest), not the
      // pre-rotation r{cap-1}.png from the stale patch.
      expect(v.imageRefs[v.imageRefs.length - 1]).toBe("fresh.png");
    });

    it("compilePrompts stamps entryRef on each compiled prompt", () => {
      const universe = {
        id: "w1",
        influences: { embrace: [], avoid: [] },
        categories: {
          landscapes: { kind: "places", variations: [{ id: "var-1", label: "L1", prompt: "p1" }] },
        },
        compositeSheets: [{ id: "sheet-1", kind: "reference_sheet", label: "S1", prompt: "sp" }],
        characters: [],
        places: [{ id: "set-abc", name: "Library" }],
        objects: [],
      };
      const variationCompiled = svc.compilePrompts(universe, { promptMode: "variations" });
      expect(variationCompiled).toHaveLength(1);
      expect(variationCompiled[0].entryRef).toEqual({ kind: "variation", categoryKey: "landscapes", id: "var-1" });

      const sheetCompiled = svc.compilePrompts(universe, { promptMode: "sheets" });
      expect(sheetCompiled).toHaveLength(1);
      expect(sheetCompiled[0].entryRef).toEqual({ kind: "sheet", id: "sheet-1" });

      const canonCompiled = svc.compilePrompts(universe, {
        promptMode: "canon",
        canonSelection: { places: "all" },
      });
      expect(canonCompiled).toHaveLength(1);
      expect(canonCompiled[0].entryRef).toEqual({ kind: "canon", kindKey: "places", id: "set-abc" });
    });

    it("imageRefs basename guard rejects path-separator filenames", async () => {
      await seedState({
        universes: [
          {
            id: "w1",
            name: "Guard",
            schemaVersion: svc.CURRENT_SCHEMA_VERSION,
            categories: {
              landscapes: {
                kind: "places",
                variations: [{ id: "var-1", label: "L", prompt: "p", imageRefs: ["../escape.png", "normal.png", "/abs/path.png", "..\\windows.png", "sub\\dir.png", "ok.png"] }],
              },
            },
            compositeSheets: [],
            createdAt: "2024-01-01T00:00:00Z",
          },
        ],
        runs: [],
      });
      const list = await svc.listUniverses();
      expect(list[0].categories.landscapes.variations[0].imageRefs).toEqual(["normal.png", "ok.png"]);
    });
  });
});

afterAll(() => {
  rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
});
