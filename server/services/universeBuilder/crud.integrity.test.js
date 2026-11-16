/**
 * crud.integrity.test.js
 *
 * sanitizers, mood-board link, insertUniverseWithId, write serialization, pending sheet slots, character psychology. Split from universeBuilder.test.js (#16214); shared
 * mocks and fixtures live in universeBuilder.testFixtures.js.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { BIBLE_LIMITS } from "../../lib/bibleLimits.js";
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

  describe("sanitizers", () => {
    it("drops malformed variations on read", async () => {
      // Manually plant invalid state — sanitizeTemplate strips it on read.
      await seedState({
        universes: [
          {
            id: "w1",
            name: "X",
            starterPrompt: "",
            stylePrompt: "",
            negativePrompt: "",
            categories: {
              landscapes: {
                variations: [
                  { label: "Good", prompt: "good prompt" },
                  { label: "", prompt: "no label" },
                  { label: "No prompt", prompt: "" },
                  null,
                ],
              },
            },
            createdAt: "2024-01-01T00:00:00Z",
          },
        ],
        runs: [],
      });
      const list = await svc.listUniverses();
      expect(list[0].categories.landscapes.variations).toHaveLength(1);
      expect(list[0].categories.landscapes.variations[0].label).toBe("Good");
    });
  });

  describe("moodBoardId (linked mood board, #4188)", () => {
    it("persists through create and is absent when never set", async () => {
      const linked = await svc.createUniverse({ name: "Linked", moodBoardId: "mb-abc123" });
      expect(linked.moodBoardId).toBe("mb-abc123");
      const bare = await svc.createUniverse({ name: "Bare" });
      expect("moodBoardId" in bare).toBe(false);
    });

    it("PATCH sets, preserves-on-absent, and clears on ''/null", async () => {
      const w = await svc.createUniverse({ name: "W" });
      const set = await svc.updateUniverse(w.id, { moodBoardId: "mb-1" });
      expect(set.moodBoardId).toBe("mb-1");
      // A patch that doesn't carry the key preserves the link.
      const untouched = await svc.updateUniverse(w.id, { logline: "still linked" });
      expect(untouched.moodBoardId).toBe("mb-1");
      // Key-present with '' clears — the field drops back to absent.
      const cleared = await svc.updateUniverse(w.id, { moodBoardId: "" });
      expect("moodBoardId" in cleared).toBe(false);
      const setAgain = await svc.updateUniverse(w.id, { moodBoardId: "mb-2" });
      expect(setAgain.moodBoardId).toBe("mb-2");
      const nulled = await svc.updateUniverse(w.id, { moodBoardId: null });
      expect("moodBoardId" in nulled).toBe(false);
    });

    it("sanitizes a non-string value to absent on read", async () => {
      await seedState({
        universes: [{ id: "w-mb", name: "X", moodBoardId: 42, createdAt: "2024-01-01T00:00:00Z" }],
        runs: [],
      });
      const list = await svc.listUniverses();
      expect("moodBoardId" in list[0]).toBe(false);
    });
  });

  describe("insertUniverseWithId", () => {
    it("preserves the caller-supplied id", async () => {
      const u = await svc.insertUniverseWithId({
        id: "550e8400-e29b-41d4-a716-446655440000",
        name: "Imported Universe",
      });
      expect(u.id).toBe("550e8400-e29b-41d4-a716-446655440000");
      expect(u.name).toBe("Imported Universe");
    });

    it("rejects malformed id", async () => {
      await expect(svc.insertUniverseWithId({ id: "bad id with spaces", name: "X" }))
        .rejects.toMatchObject({ code: svc.ERR_VALIDATION });
      await expect(svc.insertUniverseWithId({ name: "X" }))
        .rejects.toMatchObject({ code: svc.ERR_VALIDATION });
    });

    it("rejects duplicate id", async () => {
      const id = "550e8400-e29b-41d4-a716-446655440001";
      await svc.insertUniverseWithId({ id, name: "First" });
      await expect(svc.insertUniverseWithId({ id, name: "Second" }))
        .rejects.toMatchObject({ code: svc.ERR_DUPLICATE });
    });

    it("requires a name", async () => {
      await expect(svc.insertUniverseWithId({ id: "550e8400-e29b-41d4-a716-446655440002" }))
        .rejects.toMatchObject({ code: svc.ERR_VALIDATION });
    });
  });

  // Regression for "Async PATCH races on shared records — serialize writes
  // server-side" (AGENTS.md). Each updateUniverse() now goes through a
  // file-level write tail so a stale snapshot can't clobber a sibling write.
  describe("write serialization", () => {
    it("concurrent updates to the same universe preserve every field", async () => {
      const u = await svc.createUniverse({ name: "Race" });
      // Five concurrent PATCHes, each touching a different scalar field.
      // Without the queue, every call reads the same pre-PATCH snapshot and
      // the last writeState wins — only one field would survive.
      await Promise.all([
        svc.updateUniverse(u.id, { logline: "L1" }),
        svc.updateUniverse(u.id, { premise: "P1" }),
        svc.updateUniverse(u.id, { styleNotes: "S1" }),
        svc.updateUniverse(u.id, { starterPrompt: "SP1" }),
        svc.updateUniverse(u.id, { name: "N1" }),
      ]);
      const final = await svc.getUniverse(u.id);
      expect(final.logline).toBe("L1");
      expect(final.premise).toBe("P1");
      expect(final.styleNotes).toBe("S1");
      expect(final.starterPrompt).toBe("SP1");
      expect(final.name).toBe("N1");
    });

    it("concurrent updates to DIFFERENT universes preserve every field", async () => {
      // Per AGENTS.md: a Map<id, Promise> is NOT enough — both universes
      // share the same JSON file, so writes to different ids can still race.
      // The single file-level tail covers this.
      const a = await svc.createUniverse({ name: "A" });
      const b = await svc.createUniverse({ name: "B" });
      await Promise.all([
        svc.updateUniverse(a.id, { logline: "A-line", premise: "A-premise" }),
        svc.updateUniverse(b.id, { logline: "B-line", premise: "B-premise" }),
      ]);
      const fa = await svc.getUniverse(a.id);
      const fb = await svc.getUniverse(b.id);
      expect(fa.logline).toBe("A-line");
      expect(fa.premise).toBe("A-premise");
      expect(fb.logline).toBe("B-line");
      expect(fb.premise).toBe("B-premise");
    });

    it("a rejecting write does not poison the queue", async () => {
      // Force the rejection from INSIDE the queue (after the writeState would
      // run) so this actually pins poison-recovery rather than passing through
      // a fail-before-queue path. The first call's ERR_NOT_FOUND fires inside
      // the queued closure (the universe-id lookup happens after `readState`).
      const u = await svc.createUniverse({ name: "PoisonTest" });
      const results = await Promise.allSettled([
        svc.updateUniverse("nonexistent-universe", { logline: "X" }),
        svc.updateUniverse(u.id, { logline: "ok" }),
      ]);
      expect(results[0].status).toBe("rejected");
      expect(results[0].reason?.code).toBe(svc.ERR_NOT_FOUND);
      expect(results[1].status).toBe("fulfilled");
      const final = await svc.getUniverse(u.id);
      expect(final.logline).toBe("ok");
    });

    it("concurrent recordRun + updateUniverse don't clobber each other", async () => {
      const u = await svc.createUniverse({ name: "RunRace" });
      await Promise.all([
        svc.updateUniverse(u.id, { logline: "L" }),
        svc.recordRun({ id: "run-1", universeId: u.id, promptCount: 5 }),
        svc.updateUniverse(u.id, { premise: "P" }),
        svc.recordRun({ id: "run-2", universeId: u.id, promptCount: 7 }),
      ]);
      const final = await svc.getUniverse(u.id);
      const runs = await svc.listRuns(u.id);
      expect(final.logline).toBe("L");
      expect(final.premise).toBe("P");
      expect(runs).toHaveLength(2);
      expect(runs.map((r) => r.id).sort()).toEqual(["run-1", "run-2"]);
    });
  });

  // The slot map is in-process state; without these wirings entries persist
  // until the Node process restarts even after the character/universe is gone.
  describe("pending sheet slot cleanup", () => {
    it("updateUniverse clears slots for characters dropped from the PATCH", async () => {
      const slot = await import("../universeCharacterSheetSlot.js");
      const u = await svc.createUniverse({ name: "SlotPatchTest" });
      // Plant two characters via mutator (trusted path).
      await svc.updateUniverse(u.id, () => ({
        characters: [
          { id: "c-keep", name: "Keep" },
          { id: "c-drop", name: "Drop" },
        ],
      }));
      // Simulate two in-flight renders.
      slot.claimPendingSheetSlot(u.id, "c-keep", "job-keep");
      slot.claimPendingSheetSlot(u.id, "c-drop", "job-drop");
      // Drop one character via PATCH.
      await svc.updateUniverse(u.id, {
        characters: [{ id: "c-keep", name: "Keep" }],
      });
      // Slot for the dropped character is released; the survivor's slot
      // is untouched.
      expect(slot.getPendingSheetSlot(u.id, "c-drop")).toBeUndefined();
      expect(slot.getPendingSheetSlot(u.id, "c-keep")).toBe("job-keep");
      // teardown
      slot.clearPendingSheetSlotsForUniverse(u.id);
    });

    it("updateUniverse leaves slots intact when the PATCH does not remove characters", async () => {
      const slot = await import("../universeCharacterSheetSlot.js");
      const u = await svc.createUniverse({ name: "SlotIdempotentTest" });
      await svc.updateUniverse(u.id, () => ({
        characters: [{ id: "c-1", name: "One" }],
      }));
      slot.claimPendingSheetSlot(u.id, "c-1", "job-1");
      // PATCH that adds a sibling character — the original's slot must
      // survive.
      await svc.updateUniverse(u.id, {
        characters: [
          { id: "c-1", name: "One" },
          { id: "c-2", name: "Two" },
        ],
      });
      expect(slot.getPendingSheetSlot(u.id, "c-1")).toBe("job-1");
      // PATCH that touches an unrelated scalar must not disturb either.
      await svc.updateUniverse(u.id, { logline: "irrelevant" });
      expect(slot.getPendingSheetSlot(u.id, "c-1")).toBe("job-1");
      slot.clearPendingSheetSlotsForUniverse(u.id);
    });

    it("deleteUniverse releases every slot keyed by the universe", async () => {
      const slot = await import("../universeCharacterSheetSlot.js");
      const u1 = await svc.createUniverse({ name: "SlotDeleteA" });
      const u2 = await svc.createUniverse({ name: "SlotDeleteB" });
      slot.claimPendingSheetSlot(u1.id, "char-1", "job-a1");
      slot.claimPendingSheetSlot(u1.id, "char-2", "job-a2");
      slot.claimPendingSheetSlot(u2.id, "char-1", "job-b1");
      await svc.deleteUniverse(u1.id);
      expect(slot.getPendingSheetSlot(u1.id, "char-1")).toBeUndefined();
      expect(slot.getPendingSheetSlot(u1.id, "char-2")).toBeUndefined();
      // Sibling universe's slot survives.
      expect(slot.getPendingSheetSlot(u2.id, "char-1")).toBe("job-b1");
      slot.clearPendingSheetSlotsForUniverse(u2.id);
    });
  });

  // ---------------------------------------------------------------------------
  // Character psychology profile (#6414)
  // ---------------------------------------------------------------------------
  //
  // The public boundary is create → getUniverse → updateUniverse, which is what
  // the Cast tab actually drives. These cases pin the contract that makes the
  // field safe to ship into installs that already hold characters: it is
  // absent until authored, it never rewrites the legacy framework fields, a
  // partial PATCH cannot wipe the leaves it omits, and an explicit clear works.
  describe("character psychology (#6414)", () => {
    const fullProfile = () => ({
      theoryOfControl: "If I stay useful, nobody leaves.",
      strategy: "Absorbs everyone else's work and never asks for anything back.",
      protectiveBenefit: "Keeps her from ever testing whether she'd be kept anyway.",
      presentCost: "Exhaustion, and a crew who never learns to carry its own weight.",
      testingPressure: "A job she physically cannot do alone.",
      candidateChange: "Asking for help before the failure, not after.",
      drives: {
        survival: { desire: "a berth she cannot be put out of", fear: "being turned out" },
        connection: { desire: "to be kept", fear: "being easy to replace" },
        status: { desire: "to be the one the crew counts on", fear: "being read as surplus" },
      },
    });

    it("round-trips a full profile through create → load → patch, and stays ABSENT until authored", async () => {
      const w = await svc.createUniverse({
        name: "Example Universe",
        characters: [
          { name: "Nera Vost", psychology: fullProfile() },
          { name: "Unassessed Sib" },
        ],
      });
      const loaded = await svc.getUniverse(w.id);
      const nera = loaded.characters.find((c) => c.name === "Nera Vost");
      const sib = loaded.characters.find((c) => c.name === "Unassessed Sib");

      expect(nera.psychology).toEqual({ ...fullProfile(), assessment: null, assessmentNote: "" });
      // A character nobody assessed carries no key at all — legacy records stay
      // byte-identical rather than gaining an empty husk that reads as filled.
      expect("psychology" in sib).toBe(false);

      const patched = await svc.updateUniverse(w.id, (cur) => ({
        characters: cur.characters.map((c) => (c.id === nera.id
          ? { ...c, psychology: { ...c.psychology, presentCost: "A crew that never grows up." } }
          : c)),
      }));
      const repatched = patched.characters.find((c) => c.id === nera.id);
      expect(repatched.psychology.presentCost).toBe("A crew that never grows up.");
      expect(repatched.psychology.theoryOfControl).toBe(fullProfile().theoryOfControl);
      expect(repatched.psychology.drives.status.fear).toBe("being read as surplus");
    });

    it("preserves an existing Lie verbatim when a psychology profile is added", async () => {
      const lie = "I only matter if I win.";
      const w = await svc.createUniverse({
        name: "Example Universe",
        characters: [{ name: "Nera Vost", lie, want: "the salvage contract", need: "to be kept anyway" }],
      });
      const [character] = w.characters;
      const patched = await svc.updateUniverse(w.id, (cur) => ({
        characters: cur.characters.map((c) => (c.id === character.id ? { ...c, psychology: fullProfile() } : c)),
      }));
      const next = patched.characters.find((c) => c.id === character.id);
      // The Lie is a judgment ABOUT a belief and the theory of control is the
      // operating rule — related, never the same statement, never overwritten.
      expect(next.lie).toBe(lie);
      expect(next.want).toBe("the salvage contract");
      expect(next.need).toBe("to be kept anyway");
      expect(next.psychology.theoryOfControl).toBe(fullProfile().theoryOfControl);
      expect(next.psychology.theoryOfControl).not.toBe(lie);
    });

    it("a PATCH that omits nested leaves clears only what it omitted — the caller sends the whole object", async () => {
      // The universe canon PATCH is a whole-list write, so a nested field is
      // replaced by the object the caller sends. That is exactly why the editor
      // spreads the persisted profile before committing; assert the contract so
      // a future caller that forgets is caught by a failing test, not by data
      // loss on a writer's machine.
      const w = await svc.createUniverse({
        name: "Example Universe",
        characters: [{ name: "Nera Vost", psychology: fullProfile() }],
      });
      const [character] = w.characters;
      const patched = await svc.updateUniverse(w.id, (cur) => ({
        characters: cur.characters.map((c) => (c.id === character.id
          ? { ...c, psychology: { theoryOfControl: "Only the work is safe." } }
          : c)),
      }));
      const next = patched.characters.find((c) => c.id === character.id);
      expect(next.psychology.theoryOfControl).toBe("Only the work is safe.");
      expect(next.psychology.strategy).toBe("");
      expect(next.psychology.drives.survival).toEqual({ desire: "", fear: "" });
    });

    it("clears the profile on an explicit null and on an all-blank object", async () => {
      const w = await svc.createUniverse({
        name: "Example Universe",
        characters: [
          { name: "Nera Vost", psychology: fullProfile() },
          { name: "Sole Ryn", psychology: fullProfile() },
        ],
      });
      const [nera, ryn] = w.characters;
      const patched = await svc.updateUniverse(w.id, (cur) => ({
        characters: cur.characters.map((c) => {
          if (c.id === nera.id) return { ...c, psychology: null };
          if (c.id === ryn.id) return { ...c, psychology: { theoryOfControl: "   ", drives: {} } };
          return c;
        }),
      }));
      for (const id of [nera.id, ryn.id]) {
        const next = patched.characters.find((c) => c.id === id);
        expect("psychology" in next).toBe(false);
      }
    });

    it("records an explicit unknown / not-applicable ruling, and drops an unrecognized one", async () => {
      const w = await svc.createUniverse({
        name: "Example Universe",
        characters: [
          {
            name: "The Choir",
            psychology: {
              assessment: "not-applicable",
              assessmentNote: "A distributed swarm with no single interior to read a control theory from.",
            },
          },
          { name: "Bad Enum", psychology: { assessment: "definitely", theoryOfControl: "keep moving" } },
        ],
      });
      const choir = w.characters.find((c) => c.name === "The Choir");
      const badEnum = w.characters.find((c) => c.name === "Bad Enum");
      expect(choir.psychology.assessment).toBe("not-applicable");
      expect(choir.psychology.assessmentNote).toMatch(/distributed swarm/);
      expect(choir.psychology.theoryOfControl).toBe("");
      // An unrecognized ruling collapses to null rather than persisting a token
      // no consumer knows how to read — the rest of the profile survives.
      expect(badEnum.psychology.assessment).toBeNull();
      expect(badEnum.psychology.theoryOfControl).toBe("keep moving");
    });

    it("bounds every leaf and refuses a malformed nested shape", async () => {
      const w = await svc.createUniverse({
        name: "Example Universe",
        characters: [{
          name: "Nera Vost",
          psychology: {
            theoryOfControl: "x".repeat(BIBLE_LIMITS.THEORY_OF_CONTROL_MAX + 500),
            strategy: 42,
            drives: [{ desire: "not an object map" }],
          },
        }],
      });
      const [character] = w.characters;
      expect(character.psychology.theoryOfControl).toHaveLength(BIBLE_LIMITS.THEORY_OF_CONTROL_MAX);
      expect(character.psychology.strategy).toBe("");
      // A non-object `drives` still materializes the three empty axes rather
      // than persisting an array a reader would index by number.
      expect(Object.keys(character.psychology.drives)).toEqual(["survival", "connection", "status"]);
      expect(character.psychology.drives.connection).toEqual({ desire: "", fear: "" });
    });
  });
});

afterAll(() => {
  rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
});
