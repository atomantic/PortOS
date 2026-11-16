/**
 * crud.categories.test.js
 *
 * category/influence/lock/canon-backfill behaviour of the CRUD layer. Split from universeBuilder.test.js (#16214); shared
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

const { TEST_DATA_ROOT, seedState, seedWorld } = h;
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

  describe("influences", () => {
    // These tests probe the per-list sanitizer in isolation, so they override
    // seedWorld's default influences with their own to keep the assertions
    // focused on the input under test (the default influences would otherwise
    // round-trip alongside and confuse the expected output).
    it("round-trips embrace + avoid lists through createUniverse", async () => {
      const w = await seedWorld({
        influences: {
          embrace: ["Moebius", "cel-shading"],
          avoid: ["Ghibli painterly", "neon cyberpunk"],
        },
      });
      expect(w.influences.embrace).toEqual(["Moebius", "cel-shading"]);
      expect(w.influences.avoid).toEqual([
        "Ghibli painterly",
        "neon cyberpunk",
      ]);
    });

    it("dedupes influences case-insensitively, trims, drops empties + invalid types", async () => {
      const w = await seedWorld({
        influences: {
          embrace: ["Moebius", "moebius", "  cel-shading  ", "", 42, null],
          avoid: ["Ghibli", "ghibli"],
        },
      });
      expect(w.influences.embrace).toEqual(["Moebius", "cel-shading"]);
      expect(w.influences.avoid).toEqual(["Ghibli"]);
    });

    it("defaults to empty lists when influences is missing or invalid", async () => {
      // seedWorld seeds non-empty influences by default — override with empty
      // lists so this test isolates the missing/invalid branch.
      const w = await seedWorld({ influences: { embrace: [], avoid: [] } });
      expect(w.influences).toEqual({ embrace: [], avoid: [] });
      const w2 = await seedWorld({
        name: "second",
        influences: "not-an-object",
      });
      expect(w2.influences).toEqual({ embrace: [], avoid: [] });
    });

    it("caps influence lists at INFLUENCES_PER_LIST_MAX", async () => {
      const tooMany = Array.from(
        { length: svc.INFLUENCES_PER_LIST_MAX + 12 },
        (_, i) => `ref-${i}`,
      );
      const w = await seedWorld({
        influences: { embrace: tooMany, avoid: [] },
      });
      expect(w.influences.embrace).toHaveLength(svc.INFLUENCES_PER_LIST_MAX);
    });

    it("updateUniverse replaces influence lists wholesale (does not merge)", async () => {
      const w = await seedWorld({
        influences: { embrace: ["A", "B"], avoid: ["X"] },
      });
      const patched = await svc.updateUniverse(w.id, {
        influences: { embrace: ["C"] },
      });
      // Wholesale replace: avoid is gone because the patch didn't carry it.
      expect(patched.influences.embrace).toEqual(["C"]);
      expect(patched.influences.avoid).toEqual([]);
    });

    it("compilePrompts joins embrace verbatim into prompt + avoid into negative", async () => {
      const w = await seedWorld({
        influences: {
          embrace: ["Moebius", "cel-shading", "ink", "dust palette"],
          avoid: ["ghibli painterly", "lowres"],
        },
      });
      const compiled = svc.compilePrompts(w, {
        selection: { landscapes: ["Crystal Canyon"] },
      });
      expect(compiled).toHaveLength(1);
      // Embrace tokens land verbatim as the style prefix, joined with the
      // variation prompt via composeStyledPrompt's `. ` separator.
      expect(compiled[0].prompt).toBe(
        "Moebius, cel-shading, ink, dust palette. crystalline canyon, alien sun",
      );
      // Avoid tokens become the negative prompt verbatim.
      expect(compiled[0].negativePrompt).toBe("ghibli painterly, lowres");
    });

    it("compilePrompts absorbs legacy prose stylePrompt/negativePrompt into the chip lists", async () => {
      const w = await seedWorld({
        // Stale v2-shaped payload — prose tokens migrate into the chip lists
        // alongside any pre-existing influences and dedupe case-insensitively.
        stylePrompt: "cel-shading, ink, dust palette",
        negativePrompt: "lowres",
        influences: {
          embrace: ["Moebius", "cel-shading"],
          avoid: ["ghibli painterly", "lowres"],
        },
      });
      const compiled = svc.compilePrompts(w, {
        selection: { landscapes: ["Crystal Canyon"] },
      });
      expect(compiled).toHaveLength(1);
      // Chip tokens stay at the front (preserve user ordering); prose tokens
      // land at the tail. "cel-shading" / "lowres" dedupe at the sanitizer.
      expect(compiled[0].prompt).toBe(
        "Moebius, cel-shading, ink, dust palette. crystalline canyon, alien sun",
      );
      expect((compiled[0].prompt.match(/cel-shading/g) || []).length).toBe(1);
      expect(compiled[0].negativePrompt).toBe("ghibli painterly, lowres");
      expect((compiled[0].negativePrompt.match(/lowres/g) || []).length).toBe(1);
    });
  });

  describe("per-item locks", () => {
    it("defaults variations to locked + preserves explicit lock state", async () => {
      // Variations now lock-by-default: an entry with no `locked` field
      // reads as locked, and explicit `false` survives the round-trip so
      // a user-unlock isn't silently re-locked on the next read.
      const w = await seedWorld({
        categories: {
          landscapes: {
            variations: [
              { label: "Pinned canyon", prompt: "pinned canyon prompt", locked: true },
              { label: "Open canyon", prompt: "open canyon prompt" },
              { label: "Hand-unlocked", prompt: "hand unlocked prompt", locked: false },
            ],
          },
        },
      });
      const vs = w.categories.landscapes.variations;
      expect(vs.find((v) => v.label === "Pinned canyon").locked).toBe(true);
      expect(vs.find((v) => v.label === "Open canyon").locked).toBe(true);
      expect(vs.find((v) => v.label === "Hand-unlocked").locked).toBe(false);
    });

    it("coerces non-boolean `locked` values to the locked-by-default state", async () => {
      // Anything other than `false` collapses to the default (true); only
      // explicit `false` records an unlock.
      const w = await seedWorld({
        categories: {
          landscapes: {
            variations: [
              { label: "A", prompt: "a", locked: false },
              { label: "B", prompt: "b", locked: "yes" },
              { label: "C", prompt: "c", locked: 1 },
            ],
          },
        },
      });
      const labels = Object.fromEntries(
        w.categories.landscapes.variations.map((v) => [v.label, v.locked]),
      );
      expect(labels.A).toBe(false);
      expect(labels.B).toBe(true);
      expect(labels.C).toBe(true);
    });

    it("defaults composite sheets to locked + preserves explicit lock state", async () => {
      const w = await seedWorld({
        compositeSheets: [
          {
            label: "Pinned poster",
            prompt: "pinned poster prompt long enough",
            kind: "world_pitch_poster",
            locked: true,
          },
          { label: "Open sheet", prompt: "open sheet prompt long enough" },
          { label: "Unlocked sheet", prompt: "unlocked sheet prompt long enough", locked: false },
        ],
      });
      expect(
        w.compositeSheets.find((s) => s.label === "Pinned poster").locked,
      ).toBe(true);
      expect(
        w.compositeSheets.find((s) => s.label === "Open sheet").locked,
      ).toBe(true);
      expect(
        w.compositeSheets.find((s) => s.label === "Unlocked sheet").locked,
      ).toBe(false);
    });
  });

  describe("setVariationsLockAll", () => {
    const seedTwoBuckets = () =>
      seedWorld({
        categories: {
          landscapes: {
            variations: [
              { label: "A", prompt: "a" },
              { label: "B", prompt: "b", locked: false },
            ],
          },
          outfits: {
            variations: [
              { label: "X", prompt: "x" },
              { label: "Y", prompt: "y" },
            ],
          },
        },
      });

    it("scopes total + changed counts to a single bucket when categoryKey is set", async () => {
      // Regression guard: previously `total += variations.length` ran before
      // the categoryKey filter, so a single-bucket call over-reported the
      // denominator as every variation universe-wide.
      const w = await seedTwoBuckets();
      const res = await svc.setVariationsLockAll(w.id, {
        categoryKey: "landscapes",
        locked: false,
      });
      expect(res.total).toBe(2); // only landscapes' variations counted
      expect(res.changed).toBe(1); // only "A" flipped (true → false); "B" already false
      const reread = (await svc.listUniverses())[0];
      expect(reread.categories.landscapes.variations.every((v) => v.locked === false)).toBe(true);
      // Other bucket untouched.
      expect(reread.categories.outfits.variations.every((v) => v.locked === true)).toBe(true);
    });

    it("universe-wide path locks every variation across every bucket", async () => {
      const w = await seedTwoBuckets();
      // First, unlock everything explicitly so the test's "lock all" call has
      // real work to do (sanitizer defaults new variations to locked).
      await svc.setVariationsLockAll(w.id, { locked: false });
      const res = await svc.setVariationsLockAll(w.id, { locked: true });
      expect(res.total).toBe(4); // 2 landscapes + 2 outfits
      expect(res.changed).toBe(4);
      const reread = (await svc.listUniverses())[0];
      for (const bucket of Object.values(reread.categories)) {
        expect(bucket.variations.every((v) => v.locked === true)).toBe(true);
      }
    });

    it("includeSheets: true also flips composite sheets in the same call (only when no categoryKey)", async () => {
      const w = await seedWorld({
        compositeSheets: [
          { label: "Cover board", prompt: "cover board prompt long enough" },
        ],
      });
      await svc.setVariationsLockAll(w.id, { locked: false, includeSheets: true });
      const reread = (await svc.listUniverses())[0];
      expect(reread.compositeSheets[0].locked).toBe(false);
    });

    it("ignores includeSheets when a categoryKey is set (single-bucket scope is strict)", async () => {
      const w = await seedWorld({
        compositeSheets: [
          { label: "Cover board", prompt: "cover board prompt long enough" },
        ],
      });
      await svc.setVariationsLockAll(w.id, {
        categoryKey: "landscapes",
        locked: false,
        includeSheets: true,
      });
      const reread = (await svc.listUniverses())[0];
      expect(reread.compositeSheets[0].locked).toBe(true); // still locked
    });
  });

  describe("locked", () => {
    it("round-trips a sparse lock map and replaces wholesale on patch", async () => {
      const w = await seedWorld({
        locked: { logline: true, influencesEmbrace: true },
      });
      expect(w.locked).toEqual({ logline: true, influencesEmbrace: true });
      const patched = await svc.updateUniverse(w.id, {
        locked: { styleNotes: true },
      });
      expect(patched.locked).toEqual({ styleNotes: true });
    });

    it("ignores non-true / unknown lock keys", async () => {
      const w = await seedWorld({
        locked: { logline: false, bogus: true, premise: true },
      });
      expect(w.locked).toEqual({ premise: true });
    });

    it("migrates legacy `locked.influences: true` into per-list locks", async () => {
      // Prior schema combined embrace + avoid into one `influences` lock. The
      // sanitizer now splits it into two so existing on-disk universes keep working
      // without a data migration step.
      const w = await seedWorld({ locked: { influences: true, premise: true } });
      expect(w.locked).toEqual({
        premise: true,
        influencesEmbrace: true,
        influencesAvoid: true,
      });
    });
  });

  describe("categories→canon backfill", () => {
    it("upgrades v4 to v5 without re-folding exploratory categories into canon", () => {
      const w = svc.sanitizeTemplate({
        id: "world-v4",
        name: "Already backfilled",
        schemaVersion: 4,
        categories: {
          landscapes: { kind: "places", variations: [{ label: "New Vista", prompt: "exploratory" }] },
        },
        characters: [],
        places: [],
        objects: [],
      });
      expect(w.schemaVersion).toBe(svc.CURRENT_SCHEMA_VERSION);
      expect(w.places).toEqual([]);
      expect(w.styleReferences).toEqual([]);
    });

    it("backfills canon arrays from categories on first read + stamps the current schema version", async () => {
      await seedState({
        universes: [
          {
            id: "w-v1", name: "Legacy",
            starterPrompt: "old", stylePrompt: "", negativePrompt: "",
            categories: {
              characters: { variations: [{ label: "Alex", prompt: "field lead detective" }] },
              landscapes: { variations: [{ label: "Crystal Canyon", prompt: "canyon, alien sun", locked: true }] },
              environments: { variations: [{ label: "Bubble Room", prompt: "pastel lab" }] },
              vehicles: { variations: [{ label: "Rover", prompt: "dust-streaked rover" }] },
              structures: { variations: [{ label: "Monolith", prompt: "black monolith" }] },
              factions: { variations: [{ label: "Rebels", prompt: "scarred faction icon" }] }, // custom key → object tagged 'factions'
            },
            createdAt: "2024-01-01T00:00:00Z",
          },
        ],
        runs: [],
      });
      const list = await svc.listUniverses();
      const w = list[0];
      expect(w.schemaVersion).toBe(svc.CURRENT_SCHEMA_VERSION);
      // Characters
      const alex = w.characters.find((c) => c.name === "Alex");
      expect(alex).toBeTruthy();
      expect(alex.prompt).toBe("field lead detective");
      expect(alex.tags).toEqual([]);
      expect(alex.source).toBe("universe-expand");
      // Places — landscape + environment
      const canyon = w.places.find((s) => s.name === "Crystal Canyon");
      expect(canyon.tags).toEqual(["landscape"]);
      expect(canyon.locked).toBe(true); // variation lock carries through
      expect(canyon.slugline).toBe("Crystal Canyon"); // places need slugline
      const bubble = w.places.find((s) => s.name === "Bubble Room");
      expect(bubble.tags).toEqual(["environment"]);
      // Objects — vehicle + structure + custom 'factions'
      const rover = w.objects.find((o) => o.name === "Rover");
      expect(rover.tags).toEqual(["vehicle"]);
      const monolith = w.objects.find((o) => o.name === "Monolith");
      expect(monolith.tags).toEqual(["structure"]);
      const rebels = w.objects.find((o) => o.name === "Rebels");
      expect(rebels.tags).toEqual(["factions"]); // unknown category key → object catch-all
    });

    it("backfill is idempotent — re-reading an already-migrated universe does not duplicate canon", async () => {
      await seedState({
        universes: [
          {
            id: "w-v1", name: "Legacy",
            starterPrompt: "old", stylePrompt: "", negativePrompt: "",
            categories: {
              characters: { variations: [{ label: "Alex", prompt: "detective" }] },
            },
            createdAt: "2024-01-01T00:00:00Z",
          },
        ],
        runs: [],
      });
      // First read triggers backfill + persist.
      const first = (await svc.listUniverses())[0];
      expect(first.characters.length).toBe(1);
      // Second read — current schemaVersion already on disk, backfill skipped.
      const second = (await svc.listUniverses())[0];
      expect(second.characters.length).toBe(1);
      // Third read post-rename: a user-renamed entry must not be clobbered by
      // re-running backfill (the schemaVersion guard prevents the re-insert).
      const renamed = { ...second, characters: second.characters.map((c) => ({ ...c, name: "Alex Smith" })) };
      await seedState({ universes: [renamed], runs: [] });
      const third = (await svc.listUniverses())[0];
      expect(third.characters.length).toBe(1);
      expect(third.characters[0].name).toBe("Alex Smith");
    });

    it("backfill does not overwrite a pre-existing canon entry sharing a variation label", async () => {
      await seedState({
        universes: [
          {
            id: "w-mixed", name: "Mixed",
            starterPrompt: "", stylePrompt: "", negativePrompt: "",
            categories: {
              characters: { variations: [{ label: "Alex", prompt: "from variation" }] },
            },
            // Hand-authored canon entry whose name collides with the variation
            // label. Backfill must NOT overwrite — the canon entry's richer
            // metadata wins.
            characters: [{
              id: "chr-existing", name: "Alex",
              role: "Hand-authored role",
              physicalDescription: "hand-authored description",
              source: "manual",
            }],
            createdAt: "2024-01-01T00:00:00Z",
          },
        ],
        runs: [],
      });
      const w = (await svc.listUniverses())[0];
      // Still exactly one Alex (no duplicate).
      const alexes = w.characters.filter((c) => c.name === "Alex");
      expect(alexes.length).toBe(1);
      // Hand-authored fields preserved; the variation's prompt didn't bleed in.
      expect(alexes[0].role).toBe("Hand-authored role");
      expect(alexes[0].source).toBe("manual");
    });
  });

  describe("category kind (schema v4)", () => {
    it("assigns built-in default kinds (landscapes/environments/structures→settings, vehicles→objects)", async () => {
      const w = await seedWorld();
      expect(w.categories.landscapes.kind).toBe("places");
      expect(w.categories.environments.kind).toBe("places");
      expect(w.categories.structures.kind).toBe("places");
      expect(w.categories.vehicles.kind).toBe("objects");
    });

    it("defaults custom (non-built-in) buckets to 'other'", async () => {
      const w = await seedWorld({
        categories: {
          factions: { variations: [{ label: "Rebels", prompt: "x" }] },
          colonies: { variations: [{ label: "Tycho", prompt: "y" }] },
        },
      });
      expect(w.categories.factions.kind).toBe("other");
      expect(w.categories.colonies.kind).toBe("other");
    });

    it("honors an explicit valid `kind` from the input over the built-in default", async () => {
      const w = await seedWorld({
        categories: {
          landscapes: { kind: "objects", variations: [] },
          factions: { kind: "characters", variations: [{ label: "Iron Reach", prompt: "z" }] },
        },
      });
      expect(w.categories.landscapes.kind).toBe("objects"); // override beats default
      expect(w.categories.factions.kind).toBe("characters");
    });

    it("falls back to default when explicit `kind` is invalid", async () => {
      const w = await seedWorld({
        categories: {
          landscapes: { kind: "not-a-kind", variations: [] },
          vehicles: { kind: 42, variations: [] },
          colonies: { kind: null, variations: [{ label: "Tycho", prompt: "x" }] },
        },
      });
      expect(w.categories.landscapes.kind).toBe("places"); // built-in default
      expect(w.categories.vehicles.kind).toBe("objects"); // built-in default
      expect(w.categories.colonies.kind).toBe("other"); // custom fallback
    });

    it("drops the legacy default `characters` bucket and folds variations into canon", async () => {
      const w = await seedWorld({
        categories: {
          // Mimic a v3 client (or post-migration tab) accidentally sending the
          // retired bucket — sanitize folds it into canon.characters[] and
          // drops the bucket entirely.
          characters: {
            variations: [
              { label: "Ash", prompt: "young survivor with iron rebar" },
              { label: "Roan", prompt: "weathered scavenger" },
            ],
          },
        },
      });
      expect(w.categories.characters).toBeUndefined();
      const ash = w.characters.find((c) => c.name === "Ash");
      const roan = w.characters.find((c) => c.name === "Roan");
      expect(ash).toBeDefined();
      expect(ash.prompt).toBe("young survivor with iron rebar");
      expect(roan).toBeDefined();
    });

    it("WORLD_CATEGORIES no longer includes `characters`", () => {
      expect(svc.WORLD_CATEGORIES).not.toContain("characters");
      expect(svc.WORLD_CATEGORIES).toEqual(
        expect.arrayContaining(["landscapes", "environments", "structures", "vehicles"]),
      );
    });

    it("kind round-trips through update", async () => {
      const w = await seedWorld({
        categories: { factions: { variations: [{ label: "Iron Reach", prompt: "x" }] } },
      });
      const patched = await svc.updateUniverse(w.id, {
        categories: { factions: { kind: "characters", variations: [{ label: "Iron Reach", prompt: "x" }] } },
      });
      expect(patched.categories.factions.kind).toBe("characters");
    });
  });

  describe("factual flag (#7616)", () => {
    it("persists `factual` only when true, leaving a fiction universe byte-identical", async () => {
      const base = {
        id: "w-factual", name: "Example Universe",
        schemaVersion: svc.CURRENT_SCHEMA_VERSION, createdAt: "2024-01-01T00:00:00Z",
      };
      // The regression this catches: persisting `factual: false` would add a key
      // to EVERY existing universe's record, changing the wire checksum that
      // peer sync and the conflict journal both hash — so every untouched world
      // would look edited on the next sync.
      const fiction = svc.sanitizeTemplate(base);
      expect("factual" in fiction).toBe(false);
      expect(JSON.stringify(svc.sanitizeTemplate({ ...base, factual: false })))
        .toBe(JSON.stringify(fiction));
      expect(svc.sanitizeTemplate({ ...base, factual: true }).factual).toBe(true);
    });

    it("round-trips the flag through create and PATCH, and `false` clears it", async () => {
      const u = await svc.createUniverse({ name: "Reality", factual: true });
      expect(u.factual).toBe(true);
      expect((await svc.getUniverse(u.id)).factual).toBe(true);

      const cleared = await svc.updateUniverse(u.id, { factual: false });
      expect("factual" in cleared).toBe(false);
      expect(await svc.updateUniverse(u.id, { factual: true })).toMatchObject({ factual: true });
    });
  });
});

afterAll(() => {
  rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
});
