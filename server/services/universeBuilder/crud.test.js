/**
 * crud.test.js
 *
 * CRUD surface: create/update/delete, style references, narrative bible fields, reference-sheet preservation. Split from universeBuilder.test.js (#16214); shared
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

const { TEST_DATA_ROOT, refSheetFilesByName, seedState, seedWorld, mockUuid } = h;
const svc = await import("../universeBuilder.js");
const { naturalUniverseVisualProfile } = await import("../../lib/universeVisualProfile.js");
const cj = await import("../../lib/conflictJournal.js");
const { recordEvents, __resetSubscriptionAdapter } = await import("../sharing/recordEvents.js");

describe("universeBuilder service", () => {
  beforeEach(() => {
    h.resetFixtures(cj);
  });

  // A test that registers a subscription-adapter double must not leak it into
  // later tests even when its assertions fail mid-body.
  afterEach(() => {
    __resetSubscriptionAdapter();
  });

  it("listUniverses returns [] for fresh state", async () => {
    expect(await svc.listUniverses()).toEqual([]);
  });


  it("lists compact names and index summaries without losing legacy canon counts", async () => {
    await seedState({ universes: [
      { id: 'u-live', name: 'Live', schemaVersion: 4, createdAt: '2026-01-02T00:00:00.000Z',
        logline: 'A city', starterPrompt: 'Treatment '.repeat(1000), styleImageRefs: ['old.png', 'latest.png'],
        characters: [{ id: 'c1', name: 'Ada' }], places: [{ id: 'p1', name: 'Port' }] },
      { id: 'u-legacy', name: 'Legacy', schemaVersion: 3, createdAt: '2026-01-01T00:00:00.000Z',
        categories: { characters: { variations: [{ id: 'v1', label: 'Scout', prompt: 'A scout' }] } } },
      { id: 'u-deleted', name: 'Deleted', deleted: true },
    ] });
    const full = await svc.listUniverses();
    expect(await svc.listUniverseNames()).toEqual(full.map(({ id, name }) => ({ id, name })));
    const summaries = await svc.listUniverseSummaries();
    expect(summaries).toEqual(full.map((u) => ({
      id: u.id, name: u.name, logline: u.logline, starterPrompt: u.starterPrompt.slice(0, svc.LOGLINE_MAX).trim(),
      origin: u.origin, createdAt: u.createdAt, updatedAt: u.updatedAt,
      factual: u.factual === true,
      canonCount: u.characters.length + u.places.length + u.objects.length,
      styleImageRef: u.styleImageRefs.at(-1) || null,
    })));
    expect(summaries.find((u) => u.id === 'u-legacy').canonCount).toBe(1);
    expect(summaries[0].styleImageRef).toBe('latest.png');
    expect(summaries[0].starterPrompt).toHaveLength(svc.LOGLINE_MAX - 1);
    expect(full[0].starterPrompt.length).toBeGreaterThan(svc.LOGLINE_MAX);
  });

  it("persists and projects photography, composes it for canon, and honors explicit off and clear", async () => {
    const profile = naturalUniverseVisualProfile();
    const world = await seedWorld({ visualProfile: profile });
    expect((await svc.getUniverse(world.id)).visualProfile).toEqual(profile);
    expect((await svc.listUniverseStyles()).find(w => w.id === world.id).visualProfile).toEqual(profile);
    expect(svc.compilePrompts(world)[0].prompt).toContain(profile.generation.lighting);
    expect(svc.compilePrompts(world, { visualProfileOverride: null })[0].prompt).not.toContain(profile.generation.lighting);
    await svc.updateUniverse(world.id, { logline: "An unrelated edit" });
    expect((await svc.getUniverse(world.id)).visualProfile).toEqual(profile);
    await svc.updateUniverse(world.id, { visualProfile: null });
    expect(await svc.getUniverse(world.id)).not.toHaveProperty("visualProfile");
  });

  describe("listUniverseStyles", () => {
    it("projects to style tokens only — no categories / canon / sheets", async () => {
      const w = await seedWorld();
      const styles = await svc.listUniverseStyles();
      expect(styles).toEqual([{
        id: w.id,
        name: "Moebius SciFi",
        influences: {
          embrace: ["moebius linework", "scavengers reign palette"],
          avoid: ["blurry", "lowres"],
        },
      }]);
    });

    it("drops universes with no style tokens — selecting one would be a no-op", async () => {
      await svc.createUniverse({ name: "Blank Slate" });
      expect(await svc.listUniverseStyles()).toEqual([]);
    });

    it("folds the legacy v2 prose stylePrompt/negativePrompt into the token lists", async () => {
      // A pre-v3 record (or one synced from an older peer) carries prose
      // instead of chips — sanitizeTemplate splits it on read, so the
      // projection must too or those universes look style-less.
      await seedState({
        universes: [{
          id: "legacy-1",
          name: "Legacy World",
          stylePrompt: "ink wash, muted palette",
          negativePrompt: "blurry",
        }],
      });
      expect(await svc.listUniverseStyles()).toEqual([{
        id: "legacy-1",
        name: "Legacy World",
        influences: { embrace: ["ink wash", "muted palette"], avoid: ["blurry"] },
      }]);
    });
  });

  it("announces a created or inserted universe to open sidebars without a federation push", async () => {
    const invalidated = [];
    const updated = [];
    const onInvalidated = ({ recordKind, recordId }) => invalidated.push(`${recordKind}:${recordId}`);
    const onUpdated = ({ recordKind }) => updated.push(recordKind);
    recordEvents.on("invalidated", onInvalidated);
    recordEvents.on("updated", onUpdated);
    const created = await svc.createUniverse({ name: "Fresh Universe" });
    const inserted = await svc.insertUniverseWithId({ id: "ub-00000000-0000-4000-8000-000000000001", name: "Imported Universe" });
    recordEvents.off("invalidated", onInvalidated);
    recordEvents.off("updated", onUpdated);
    expect(invalidated).toEqual([`universe:${created.id}`, `universe:${inserted.id}`]);
    expect(updated.filter((kind) => kind === "universe")).toEqual([]);
  });

  it("createUniverse persists with sanitized categories + kind tags", async () => {
    const w = await seedWorld();
    expect(w.id).toBe(mockUuid(1));
    expect(w.name).toBe("Moebius SciFi");
    // All default categories materialized even when only one was provided,
    // each tagged with its canon trunk via the WORLD_CATEGORY_DEFAULT_KINDS map.
    for (const c of svc.WORLD_CATEGORIES) {
      expect(w.categories[c]).toBeDefined();
      expect(Array.isArray(w.categories[c].variations)).toBe(true);
      expect(svc.CATEGORY_KINDS).toContain(w.categories[c].kind);
    }
    expect(w.categories.landscapes.variations).toHaveLength(2);
    expect(w.categories.landscapes.kind).toBe("places");
    expect(w.categories.vehicles.kind).toBe("objects");
    expect(w.categories.environments.variations).toHaveLength(0);
    // Custom (un-defaulted) bucket falls to 'other'.
    expect(w.categories.outfits.kind).toBe("other");
    expect(w.categories.outfits.variations).toHaveLength(1);
  });

  it("createUniverse preserves custom universe-building categories", async () => {
    const w = await seedWorld({
      categories: {
        "Clothing Styles": {
          variations: [
            {
              label: "Rib-Cage Nomads",
              prompt: "reference sheet, layered sailcloth, bone toggles",
            },
          ],
        },
        factions: {
          variations: [
            {
              label: "Wake Jackals",
              prompt: "spare raider kit, patched pressure masks",
            },
          ],
        },
      },
    });
    expect(w.categories.clothing_styles.variations).toEqual([
      {
        id: expect.stringMatching(/^var-/),
        label: "Rib-Cage Nomads",
        prompt: "reference sheet, layered sailcloth, bone toggles",
        imageRefs: [],
        // Variations now lock-by-default — see sanitizeVariation in
        // services/universeBuilder.js for the contract.
        locked: true,
      },
    ]);
    expect(w.categories.factions.variations).toHaveLength(1);
    expect(w.categories.landscapes.variations).toHaveLength(0);
  });

  it("createUniverse persists composite sheet prompts separately from categories", async () => {
    const w = await seedWorld({
      compositeSheets: [
        {
          label: "Gas-Giant Drifters costume sheet",
          prompt:
            "Create a clean illustrated costume reference sheet with five figures, materials swatches, fasteners, accessories, and color palette strip.",
        },
      ],
    });
    expect(w.compositeSheets).toEqual([
      {
        id: expect.stringMatching(/^sheet-/),
        kind: "reference_sheet",
        label: "Gas-Giant Drifters costume sheet",
        prompt:
          "Create a clean illustrated costume reference sheet with five figures, materials swatches, fasteners, accessories, and color palette strip.",
        imageRefs: [],
        // Composite sheets lock-by-default — see sanitizeCompositeSheet.
        locked: true,
      },
    ]);
  });

  it("createUniverse persists universe pitch poster prompts separately from categories", async () => {
    const w = await seedWorld({
      compositeSheets: [
        {
          kind: "world_pitch_poster",
          label: "Universe summary concept pitch poster",
          prompt:
            "Create a cinematic universe summary concept pitch poster with hero panorama, inset environments, cultures, creatures, visual language, color palette, materials, light atmosphere, and theme icons.",
        },
      ],
    });
    expect(w.compositeSheets).toEqual([
      {
        id: expect.stringMatching(/^sheet-/),
        kind: "world_pitch_poster",
        label: "Universe summary concept pitch poster",
        prompt:
          "Create a cinematic universe summary concept pitch poster with hero panorama, inset environments, cultures, creatures, visual language, color palette, materials, light atmosphere, and theme icons.",
        imageRefs: [],
        // Composite sheets lock-by-default — see sanitizeCompositeSheet.
        locked: true,
      },
    ]);
  });

  it("createUniverse rejects empty name", async () => {
    await expect(svc.createUniverse({ name: "" })).rejects.toThrow(
      /name is required/,
    );
  });

  it("createUniverse persists narrative bible fields (logline / premise / styleNotes)", async () => {
    const w = await seedWorld({
      logline: "A foundry city goes silent, and the only survivor is a child.",
      premise:
        "Long-form premise paragraph about the setting, conflict, stakes, and tone.",
      styleNotes:
        "Moebius linework, oil-on-canvas grain, contemplative pacing, sparse dialogue.",
    });
    expect(w.logline).toBe(
      "A foundry city goes silent, and the only survivor is a child.",
    );
    expect(w.premise).toBe(
      "Long-form premise paragraph about the setting, conflict, stakes, and tone.",
    );
    expect(w.styleNotes).toBe(
      "Moebius linework, oil-on-canvas grain, contemplative pacing, sparse dialogue.",
    );
  });

  it("updateUniverse patches narrative bible fields independently of categories", async () => {
    const w = await seedWorld({ logline: "original logline" });
    const patched = await svc.updateUniverse(w.id, {
      logline: "new logline",
      premise: "new premise",
      styleNotes: "new style notes",
    });
    expect(patched.logline).toBe("new logline");
    expect(patched.premise).toBe("new premise");
    expect(patched.styleNotes).toBe("new style notes");
    // Untouched (existing) data preserved.
    expect(patched.categories.landscapes.variations).toHaveLength(2);
    expect(patched.influences.embrace).toEqual(w.influences.embrace);
    expect(patched.influences.avoid).toEqual(w.influences.avoid);
  });

  it("updateUniverse with { replaceCategories } swaps the whole categories map (drops live-only categories)", async () => {
    const w = await seedWorld(); // seeds `landscapes` (2 vars) + custom `outfits` (1 var)
    expect(w.categories.outfits).toBeTruthy();
    // Default PATCH unions per-key — the live-only `outfits` survives.
    const unioned = await svc.updateUniverse(w.id, {
      categories: { landscapes: { variations: [{ label: "New", prompt: "p" }] } },
    });
    expect(unioned.categories.outfits).toBeTruthy();
    // With replaceCategories the patch's map replaces wholesale — `outfits` is dropped.
    const replaced = await svc.updateUniverse(
      w.id,
      { categories: { landscapes: { variations: [{ label: "New2", prompt: "p2" }] } } },
      { replaceCategories: true },
    );
    expect(replaced.categories.outfits).toBeUndefined();
    expect(replaced.categories.landscapes.variations).toHaveLength(1);
  });

  it("bumps updatedAt on a canon entry whose content changed, leaves an untouched entry's timestamp", async () => {
    // Two canon characters; edit only the first's content. The edited entry's
    // updatedAt must advance (so the canon→catalog projection's LWW clock is
    // truthful and the edit reaches the catalog row); the untouched entry keeps
    // its timestamp (no spurious projection churn).
    const w = await svc.createUniverse({
      name: "CanonClock",
      characters: [
        { name: "Ada", physicalDescription: "tall" },
        { name: "Bee", physicalDescription: "short" },
      ],
    });
    const [ada0, bee0] = w.characters;
    expect(ada0?.updatedAt).toBeTruthy();

    // Patch only Ada's description via the mutator form (the `{ ...e, ...patch }`
    // shape that previously preserved the stale updatedAt).
    const patched = await svc.updateUniverse(w.id, (cur) => ({
      characters: cur.characters.map((c) =>
        c.id === ada0.id ? { ...c, physicalDescription: "towering" } : c,
      ),
    }));

    const ada1 = patched.characters.find((c) => c.id === ada0.id);
    const bee1 = patched.characters.find((c) => c.id === bee0.id);
    expect(ada1.physicalDescription).toBe("towering");
    // Edited entry's clock advanced…
    expect(new Date(ada1.updatedAt).getTime()).toBeGreaterThan(new Date(ada0.updatedAt).getTime());
    // …untouched entry's clock unchanged.
    expect(bee1.updatedAt).toBe(bee0.updatedAt);
  });

  it("persists styleImageRefs (base style-probe renders); dedupes on create + patches wholesale", async () => {
    const w = await svc.createUniverse({ name: "Probe", styleImageRefs: ["a.png", "a.png", "b.png"] });
    expect(w.styleImageRefs).toEqual(["a.png", "b.png"]); // dedupe via sanitizeEntryImageRefs
    const patched = await svc.updateUniverse(w.id, { styleImageRefs: ["a.png", "b.png", "c.png"] });
    expect(patched.styleImageRefs).toEqual(["a.png", "b.png", "c.png"]);
    const fresh = await svc.getUniverse(w.id);
    expect(fresh.styleImageRefs).toEqual(["a.png", "b.png", "c.png"]);
  });

  it("defaults styleImageRefs to [] when absent", async () => {
    const w = await svc.createUniverse({ name: "NoProbe" });
    expect(w.styleImageRefs).toEqual([]);
  });

  it("persists analyzed style references and patches the list wholesale", async () => {
    const reference = {
      id: "style-ref-example",
      title: "Dust-lit ink wash",
      prompt: "Granular ink wash, muted ochre, weathered silhouettes",
      imageRefs: ["reference.png"],
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const w = await svc.createUniverse({
      name: "Reference Bible",
      styleReferences: [reference, { ...reference, id: "style-ref-duplicate" }],
    });
    expect(w.styleReferences).toHaveLength(2);
    expect(w.styleReferences[0]).toEqual(reference);

    const patched = await svc.updateUniverse(w.id, { styleReferences: [reference] });
    expect(patched.styleReferences).toEqual([reference]);
    expect((await svc.getUniverse(w.id)).styleReferences).toEqual([reference]);
  });

  it("addStyleReference appends inside the queued mutator so concurrent adds compose (#3109)", async () => {
    const refFor = (n) => ({
      id: `style-ref-${n}`,
      title: `Ref ${n}`,
      prompt: `Prompt ${n}`,
      imageRefs: [`ref-${n}.png`],
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const w = await svc.createUniverse({ name: "Delta Adds" });

    // Fired without awaiting the first — the record write queue serializes
    // them and each reads the freshest persisted list, so neither is lost.
    // A wholesale-replace PATCH pair built from the same base would drop one.
    await Promise.all([
      svc.addStyleReference(w.id, refFor(1)),
      svc.addStyleReference(w.id, refFor(2)),
    ]);
    const fresh = await svc.getUniverse(w.id);
    expect(fresh.styleReferences.map((r) => r.id).sort()).toEqual([
      "style-ref-1",
      "style-ref-2",
    ]);
  });

  it("addStyleReference writes adopted style guidance in the SAME queued write", async () => {
    const w = await svc.createUniverse({ name: "Adopt", influences: { embrace: ["old"], avoid: [] } });
    const updated = await svc.addStyleReference(w.id, {
      id: "style-ref-adopt",
      title: "Ink wash",
      prompt: "Granular ink wash",
      imageRefs: ["adopt.png"],
    }, {
      adopt: { styleNotes: "Tactile and muted", influences: { embrace: ["ink wash"], avoid: ["gloss"] } },
    });
    expect(updated.styleReferences).toHaveLength(1);
    expect(updated.styleNotes).toBe("Tactile and muted");
    expect(updated.influences).toEqual({ embrace: ["ink wash"], avoid: ["gloss"] });
    // Persisted together — the pair can't half-land.
    const fresh = await svc.getUniverse(w.id);
    expect(fresh.styleNotes).toBe("Tactile and muted");
    expect(fresh.styleReferences).toHaveLength(1);
  });

  it("adoptStyleGuide writes the proposed guide with no reference attached (#4188 Phase 4)", async () => {
    const w = await svc.createUniverse({ name: "Adopt Guide", influences: { embrace: ["old"], avoid: [] } });
    const updated = await svc.adoptStyleGuide(w.id, {
      styleNotes: "Board-synthesized prose",
      influences: { embrace: ["ink wash"], avoid: ["gloss"] },
    });
    expect(updated.styleNotes).toBe("Board-synthesized prose");
    expect(updated.influences).toEqual({ embrace: ["ink wash"], avoid: ["gloss"] });
    const fresh = await svc.getUniverse(w.id);
    expect(fresh.styleNotes).toBe("Board-synthesized prose");
    expect(fresh.styleReferences ?? []).toHaveLength(0);
  });

  it("adoptStyleGuide re-checks locks against the freshest persisted record", async () => {
    const w = await svc.createUniverse({
      name: "Adopt Locked",
      styleNotes: "Locked prose",
      influences: { embrace: ["keep me"], avoid: ["old bad"] },
      locked: { styleNotes: true, influencesEmbrace: true },
    });
    const updated = await svc.adoptStyleGuide(w.id, {
      styleNotes: "Should not land",
      influences: { embrace: ["should not land"], avoid: ["new bad"] },
    });
    // Locked fields keep the persisted values; the unlocked avoid list adopts.
    expect(updated.styleNotes).toBe("Locked prose");
    expect(updated.influences.embrace).toEqual(["keep me"]);
    expect(updated.influences.avoid).toEqual(["new bad"]);
  });

  it("addStyleReference is idempotent on a re-sent id and rejects an invalid reference", async () => {
    const reference = {
      id: "style-ref-once",
      title: "Once",
      prompt: "Prompt",
      imageRefs: ["once.png"],
    };
    const w = await svc.createUniverse({ name: "Idempotent" });
    await svc.addStyleReference(w.id, reference);
    // A retried request / double-click is a no-op, not a duplicate.
    const again = await svc.addStyleReference(w.id, reference);
    expect(again.styleReferences).toHaveLength(1);
    await expect(svc.addStyleReference(w.id, { title: "No prompt", imageRefs: ["x.png"] }))
      .rejects.toThrow(/Invalid style reference/);
  });

  it("addStyleReference enforces the cap against the PERSISTED list", async () => {
    const w = await svc.createUniverse({
      name: "At Cap",
      styleReferences: Array.from({ length: svc.STYLE_REFERENCES_MAX }, (_, i) => ({
        id: `style-ref-${i}`,
        title: `Ref ${i}`,
        prompt: `Prompt ${i}`,
        imageRefs: [`ref-${i}.png`],
      })),
    });
    expect(w.styleReferences).toHaveLength(svc.STYLE_REFERENCES_MAX);
    await expect(svc.addStyleReference(w.id, {
      id: "style-ref-overflow",
      title: "Overflow",
      prompt: "Prompt",
      imageRefs: ["overflow.png"],
    })).rejects.toThrow(/up to 20 art references/);
  });

  it("style-reference deltas leave canon untouched (so the projection opt-out is sound)", async () => {
    // Guard for `touchesCanon: false`: these deltas skip the per-entry
    // canon→catalog projection the mutator path normally runs, which is only
    // sound because their patch carries no canon key. If either ever starts
    // writing one, this fails and the opt-out has to go.
    const w = await svc.createUniverse({
      name: "Canon Untouched",
      characters: [{ name: "Jean", physicalDescription: "tall" }],
    });
    const before = (await svc.getUniverse(w.id)).characters;
    expect(before).toHaveLength(1);

    const reference = { id: "style-ref-x", title: "X", prompt: "x", imageRefs: ["x.png"] };
    const added = await svc.addStyleReference(w.id, reference);
    expect(added.characters).toEqual(before);
    const removed = await svc.removeStyleReference(w.id, reference.id);
    expect(removed.characters).toEqual(before);
  });

  it("removeStyleReference drops one by id and no-ops on an id that is already gone", async () => {
    const refA = { id: "style-ref-a", title: "A", prompt: "a", imageRefs: ["a.png"] };
    const refB = { id: "style-ref-b", title: "B", prompt: "b", imageRefs: ["b.png"] };
    const w = await svc.createUniverse({ name: "Delta Removes", styleReferences: [refA, refB] });

    // Concurrent removals: each filters the freshest list, so both land — the
    // case a pair of wholesale-replace PATCHes needed client-side queuing for.
    await Promise.all([
      svc.removeStyleReference(w.id, refA.id),
      svc.removeStyleReference(w.id, refB.id),
    ]);
    expect((await svc.getUniverse(w.id)).styleReferences).toEqual([]);

    // Already gone (a duplicate delete, or one that raced the image-delete
    // purge) resolves with the unchanged record instead of throwing.
    const noop = await svc.removeStyleReference(w.id, refA.id);
    expect(noop.styleReferences).toEqual([]);
  });

  it("drops invalid style references and defaults the field to an empty list", async () => {
    const w = await svc.createUniverse({
      name: "Reference Validation",
      styleReferences: [
        { title: "Missing prompt", imageRefs: ["reference.png"] },
        { title: "Missing image", prompt: "Prompt", imageRefs: [] },
        { title: "Traversal", prompt: "Prompt", imageRefs: ["../secret.png"] },
      ],
    });
    expect(w.styleReferences).toEqual([]);
  });

  it("createUniverse trims bible fields to their max length", async () => {
    const w = await seedWorld({
      logline: "x".repeat(svc.LOGLINE_MAX + 50),
      premise: "y".repeat(svc.PREMISE_MAX + 50),
      styleNotes: "z".repeat(svc.STYLE_NOTES_MAX + 50),
    });
    expect(w.logline).toHaveLength(svc.LOGLINE_MAX);
    expect(w.premise).toHaveLength(svc.PREMISE_MAX);
    expect(w.styleNotes).toHaveLength(svc.STYLE_NOTES_MAX);
  });

  // Starter idea is intentionally uncapped at the legacy 4000-char limit —
  // the cap was raised to 200,000 (a sanity ceiling, not an artificial
  // brevity constraint). These tests pin the new boundary so a future
  // refactor can't silently regress to the old 4k limit.
  it("createUniverse preserves a starterPrompt well beyond the legacy 4000-char limit", async () => {
    const longPrompt = "a".repeat(50_000);
    const w = await seedWorld({ starterPrompt: longPrompt });
    expect(w.starterPrompt).toHaveLength(50_000);
    expect(w.starterPrompt).toBe(longPrompt);
  });

  it("createUniverse trims a starterPrompt exceeding STARTER_PROMPT_MAX (200k)", async () => {
    const w = await seedWorld({
      starterPrompt: "b".repeat(svc.STARTER_PROMPT_MAX + 5_000),
    });
    expect(w.starterPrompt).toHaveLength(svc.STARTER_PROMPT_MAX);
  });

  it("STARTER_PROMPT_MAX is at least the documented 200k ceiling", async () => {
    // Guard against accidental regression to the legacy 4k cap.
    expect(svc.STARTER_PROMPT_MAX).toBeGreaterThanOrEqual(200_000);
  });

  it("updateUniverse merges partial patches", async () => {
    const w = await seedWorld();
    const patched = await svc.updateUniverse(w.id, {
      name: "Renamed",
      // Legacy stale-client shape: prose stylePrompt gets split into chips and
      // appended to influences.embrace by the sanitizer's v2 → v3 migration.
      stylePrompt: "new style",
    });
    expect(patched.name).toBe("Renamed");
    // The legacy prose was absorbed as a single token at the tail of embrace.
    expect(patched.influences.embrace).toEqual([
      ...w.influences.embrace,
      "new style",
    ]);
    // The legacy field is no longer stored on the record.
    expect(patched.stylePrompt).toBeUndefined();
    // Untouched fields preserved.
    expect(patched.starterPrompt).toBe(w.starterPrompt);
    expect(patched.categories.landscapes.variations).toHaveLength(2);
  });

  it("updateUniverse throws NOT_FOUND for unknown id", async () => {
    await expect(
      svc.updateUniverse("no-such", { name: "X" }),
    ).rejects.toMatchObject({ code: svc.ERR_NOT_FOUND });
  });

  it("updateUniverse accepts a mutator(latest) callback that runs inside the queue", async () => {
    const w = await seedWorld({ logline: "before" });
    const mutator = vi.fn(async (latest) => {
      expect(latest.id).toBe(w.id);
      return { logline: `${latest.logline} → after` };
    });
    const patched = await svc.updateUniverse(w.id, mutator);
    expect(mutator).toHaveBeenCalledTimes(1);
    expect(patched.logline).toBe("before → after");
  });

  it("updateUniverse short-circuits with no write when the mutator returns null", async () => {
    const w = await seedWorld();
    const beforeUpdatedAt = w.updatedAt;
    const patched = await svc.updateUniverse(w.id, async () => null);
    // No write happened: updatedAt unchanged, no rename cascade fired.
    expect(patched.updatedAt).toBe(beforeUpdatedAt);
    expect(patched.id).toBe(w.id);
  });

  it("updateUniverse mutator that throws propagates without writing", async () => {
    const w = await seedWorld({ logline: "untouched" });
    await expect(
      svc.updateUniverse(w.id, async () => { throw new Error("mutator boom"); }),
    ).rejects.toThrow("mutator boom");
    const fresh = await svc.getUniverse(w.id);
    expect(fresh.logline).toBe("untouched");
  });

  it("updateUniverse mutator returning a non-object value throws ERR_VALIDATION", async () => {
    const w = await seedWorld();
    await expect(
      svc.updateUniverse(w.id, async () => "not-an-object"),
    ).rejects.toMatchObject({ code: svc.ERR_VALIDATION });
    // Arrays are `typeof 'object'` but would silently no-op the categories
    // merge — reject them explicitly.
    await expect(
      svc.updateUniverse(w.id, async () => []),
    ).rejects.toMatchObject({ code: svc.ERR_VALIDATION });
  });

  it("updateUniverse mutator sees concurrent writes that landed before it ran (queued)", async () => {
    const w = await seedWorld({ logline: "v0" });
    // Two updates issued in parallel against the same record. The queue
    // serializes them: the mutator sees the result of the first write.
    const [first, second] = await Promise.all([
      svc.updateUniverse(w.id, { logline: "v1" }),
      svc.updateUniverse(w.id, async (latest) => ({
        logline: `${latest.logline}+v2`,
      })),
    ]);
    expect(first.logline).toBe("v1");
    expect(second.logline).toBe("v1+v2");
  });

  it("updateUniverse cascades a name change onto the linked media collection", async () => {
    const collections = await import("../mediaCollections.js");
    const w = await seedWorld();
    // Seed a linked collection. The render route uses
    // findOrCreateUniverseCollection (universeId-first); we use the
    // name-first helper here only because the resulting record is
    // shape-identical and avoids dragging in the production route's
    // dependencies for this rename-cascade-focused test.
    await collections.findOrCreateCollectionByName({
      name: collections.universeCollectionNameFor(w.name),
      universeId: w.id,
    });
    await svc.updateUniverse(w.id, { name: "Renamed Universe" });
    const linked = await collections.findCollectionByUniverseId(w.id);
    expect(linked?.name).toBe("Universe: Renamed Universe");
  });

  it("updateUniverse rename succeeds even when no linked collection exists", async () => {
    const w = await seedWorld();
    const patched = await svc.updateUniverse(w.id, { name: "Solo Rename" });
    expect(patched.name).toBe("Solo Rename");
  });

  it("updateUniverse preserves server-owned referenceSheetImageRef across character PATCHes", async () => {
    // Multi-tab race: tab B finished a newer sheet render (server pointer is
    // 'sheet-B.png'), tab A PATCH-saves with a character body it loaded
    // BEFORE the render landed (still carrying the previous 'sheet-A.png',
    // or null). Without server-side preservation the older PATCH would
    // clobber the newer server pointer and the UI would 404 on the stale
    // filename. The render-completion handler bypasses this preservation
    // path because it writes referenceSheetImageRef inside its own
    // updateUniverse mutator from the latest record state.
    const w = await seedWorld();
    // Simulate the render-completion stamp via an in-queue mutator (same
    // path the real onSheetComplete uses).
    await svc.updateUniverse(w.id, (latest) => {
      const next = [...(latest.characters || []), {
        id: "c-1", name: "Vale", referenceSheetImageRef: "sheet-B.png",
        referenceSheetRequests: { standard: "11111111-1111-4111-8111-111111111111" },
      }];
      return { characters: next };
    });
    // Client PATCH that round-trips a stale body — sheet pointer is the
    // OLD value (or null). Server should keep 'sheet-B.png' regardless.
    const afterClientPatch = await svc.updateUniverse(w.id, {
      characters: [{ id: "c-1", name: "Vale", referenceSheetImageRef: "sheet-A.png" }],
    });
    const char = afterClientPatch.characters.find((c) => c.id === "c-1");
    expect(char?.referenceSheetImageRef).toBe("sheet-B.png");

    // Same invariant when client PATCHes with the field omitted entirely.
    const afterOmitPatch = await svc.updateUniverse(w.id, {
      characters: [{ id: "c-1", name: "Vale" }],
    });
    const charOmit = afterOmitPatch.characters.find((c) => c.id === "c-1");
    expect(charOmit?.referenceSheetImageRef).toBe("sheet-B.png");
    expect(charOmit?.referenceSheetRequests).toEqual({ standard: "11111111-1111-4111-8111-111111111111" });

    // Mutator path (the render-completion handler) IS trusted to update
    // referenceSheetImageRef — it constructs the patch from the latest
    // record. Preservation must NOT run against mutator output, or the
    // newly-stamped filename gets clobbered back to the old value.
    const afterRenderStamp = await svc.updateUniverse(w.id, (latest) => {
      const next = (latest.characters || []).map((c) =>
        c.id === "c-1" ? { ...c, referenceSheetImageRef: "sheet-C.png" } : c,
      );
      return { characters: next };
    });
    const charAfterStamp = afterRenderStamp.characters.find((c) => c.id === "c-1");
    expect(charAfterStamp?.referenceSheetImageRef).toBe("sheet-C.png");
  });

  it("updateUniverse preserves canon entry imageRefs across a stale whole-array PATCH (#1395)", async () => {
    // The collection hook appends section-local / batch renders onto a canon
    // entry's imageRefs[] via appendEntryImageRef (mutator form). A literal
    // whole-array PATCH (inline canon edit / add / lock) that round-trips a
    // character list the client loaded BEFORE the render landed must not
    // clobber the freshly-appended filename.
    const w = await seedWorld({
      characters: [{ id: "c-ref", name: "Ref", physicalDescription: "a face" }],
    });
    // Durable append — the hook's path (mutator form, bypasses preservation).
    await svc.appendEntryImageRef(w.id, { kind: "canon", kindKey: "characters", id: "c-ref" }, "render-1.png");

    // Stale client PATCH: round-trips the character WITHOUT the new ref.
    const afterStale = await svc.updateUniverse(w.id, {
      characters: [{ id: "c-ref", name: "Ref (renamed)", physicalDescription: "a face", imageRefs: [] }],
    });
    const refChar = afterStale.characters.find((c) => c.id === "c-ref");
    expect(refChar?.imageRefs).toEqual(["render-1.png"]); // preserved
    expect(refChar?.name).toBe("Ref (renamed)");          // other edits still apply

    // Mutator path stays trusted — a subsequent append lands normally.
    await svc.appendEntryImageRef(w.id, { kind: "canon", kindKey: "characters", id: "c-ref" }, "render-2.png");
    const afterSecond = await svc.getUniverse(w.id);
    const refChar2 = afterSecond.characters.find((c) => c.id === "c-ref");
    expect(refChar2?.imageRefs).toEqual(["render-1.png", "render-2.png"]);
  });

  it("updateUniverse preservation skips when cur's referenceSheetImageRef no longer resolves on disk", async () => {
    // GET /:id runs pruneStaleReferenceSheets, returning null when the
    // underlying file is gone. Client PATCHes carry the pruned null. The
    // preservation guard MUST honor that null by skipping preservation —
    // otherwise the stale filename comes back from cur and the UI 404s
    // again. resolveImageRef returning null is the "file missing" signal.
    const w = await seedWorld();
    // Stamp a sheet (mutator path is trusted).
    await svc.updateUniverse(w.id, (latest) => {
      const next = [...(latest.characters || []), {
        id: "c-stale", name: "Stale", referenceSheetImageRef: "sheet-DEAD.png",
      }];
      return { characters: next };
    });
    // Mark that filename as missing for the resolveImageRef mock.
    refSheetFilesByName.set("sheet-DEAD.png", null);
    // Client PATCH that carries the pruned null (matching what GET would
    // surface after pruneStaleReferenceSheets ran). Preservation should
    // detect the stale cur value and skip, so the null wins.
    const after = await svc.updateUniverse(w.id, {
      characters: [{ id: "c-stale", name: "Stale", referenceSheetImageRef: null }],
    });
    const stale = after.characters.find((c) => c.id === "c-stale");
    expect(stale?.referenceSheetImageRef).toBeNull();
    // Clean up the per-test FS shim so later tests start clean.
    refSheetFilesByName.delete("sheet-DEAD.png");
  });

  it("updateUniverse preserves server-owned referenceSheets[<variant>] map across literal PATCHes", async () => {
    // Same multi-tab race, but for the map-stored variants (blueprint, etc.).
    // A render-completion mutator stamps `referenceSheets.blueprint`; a stale
    // client PATCH that round-trips a body with the field omitted (or with
    // an older snapshot) must NOT lose the freshly-stamped variant. Per-key
    // preservation means a separately-rendered legacy 'standard' sheet
    // survives even when only blueprint is in the map.
    const w = await seedWorld();
    await svc.updateUniverse(w.id, (latest) => ({
      characters: [...(latest.characters || []), {
        id: "c-map", name: "Vex",
        referenceSheetImageRef: "sheet-STD.png",
        referenceSheets: { blueprint: "sheet-BP.png" },
      }],
    }));
    // PATCH that omits referenceSheets entirely — guard must preserve both
    // the legacy 'standard' field AND the blueprint map slot.
    const afterOmit = await svc.updateUniverse(w.id, {
      characters: [{ id: "c-map", name: "Vex" }],
    });
    const c1 = afterOmit.characters.find((c) => c.id === "c-map");
    expect(c1?.referenceSheetImageRef).toBe("sheet-STD.png");
    expect(c1?.referenceSheets).toEqual({ blueprint: "sheet-BP.png" });

    // PATCH that carries an older map (a different variant set or stale
    // filename). Cur's still-resolvable entries override the patch's same
    // keys; the patch's other keys flow through.
    const afterStale = await svc.updateUniverse(w.id, {
      characters: [{ id: "c-map", name: "Vex", referenceSheets: { blueprint: "sheet-OLD.png", noir: "sheet-NOIR.png" } }],
    });
    const c2 = afterStale.characters.find((c) => c.id === "c-map");
    expect(c2?.referenceSheets.blueprint).toBe("sheet-BP.png"); // cur wins (resolves)
    expect(c2?.referenceSheets.noir).toBe("sheet-NOIR.png"); // patch-only key flows through
  });

  it("updateUniverse persists null for stale referenceSheetImageRef on the write path, not just GET", async () => {
    // Reviewer-found bug: the GET-route pruner nulled the response but the
    // on-disk record kept the stale filename, so a later PATCH that omitted
    // `characters` (e.g. rename) merged from cur and returned the stale value.
    // The write-time prune in updateUniverse fixes this — any PATCH catches
    // the on-disk record up.
    const w = await seedWorld();
    await svc.updateUniverse(w.id, (latest) => ({
      characters: [...(latest.characters || []), {
        id: "c-rename", name: "Anchor", referenceSheetImageRef: "sheet-RENAME.png",
      }],
    }));
    refSheetFilesByName.set("sheet-RENAME.png", null);
    // PATCH that does NOT include `characters` — only renames the universe.
    const renamed = await svc.updateUniverse(w.id, { name: "Renamed" });
    const char = renamed.characters.find((c) => c.id === "c-rename");
    expect(char?.referenceSheetImageRef).toBeNull();
    // And a follow-up GET sees the same null — disk is now consistent.
    const reread = await svc.getUniverse(w.id);
    const charReread = reread.characters.find((c) => c.id === "c-rename");
    expect(charReread?.referenceSheetImageRef).toBeNull();
    refSheetFilesByName.delete("sheet-RENAME.png");
  });

  it("deleteUniverse removes the universe and its runs", async () => {
    const w = await seedWorld();
    await svc.recordRun({
      id: "run-1",
      universeId: w.id,
      collectionId: "col-1",
      jobIds: ["j1"],
      promptCount: 3,
    });
    expect(await svc.listRuns(w.id)).toHaveLength(1);
    await svc.deleteUniverse(w.id);
    expect(await svc.listUniverses()).toEqual([]);
    expect(await svc.listRuns(w.id)).toEqual([]);
  });

  it("deleteUniverse is BLOCKED while live series reference it (hierarchy invariant)", async () => {
    const seriesSvc = await import("../pipeline/series.js");
    const w = await seedWorld();
    const ser = await seriesSvc.createSeries({ name: "Child Arc", universeId: w.id });

    // Block: the universe still has a live child series.
    await expect(svc.deleteUniverse(w.id)).rejects.toMatchObject({
      code: svc.ERR_HAS_LIVE_SERIES,
      blockingSeries: [{ id: ser.id, name: "Child Arc" }],
    });
    // Universe is untouched.
    expect(await svc.listUniverses()).toHaveLength(1);

    // Once the child is gone, the delete succeeds.
    await seriesSvc.deleteSeries(ser.id);
    await expect(svc.deleteUniverse(w.id)).resolves.toMatchObject({ id: w.id });
    expect(await svc.listUniverses()).toEqual([]);
  });

  it("deleteUniverse unlinks linked media collections (releases the rename-lock)", async () => {
    const collections = await import("../mediaCollections.js");
    const w = await seedWorld();
    // Seed a linked collection (see rename-cascade test above for why we
    // use the name-first helper here even though production routes through
    // findOrCreateUniverseCollection).
    const linked = await collections.findOrCreateCollectionByName({
      name: collections.universeCollectionNameFor(w.name),
      universeId: w.id,
    });
    expect(linked.universeId).toBe(w.id);
    await svc.deleteUniverse(w.id);
    // Collection survives — the user may still want the renders.
    const fresh = await collections.getCollection(linked.id);
    // …but the `universeId` is cleared so the rename-lock no longer applies.
    expect(fresh.universeId).toBeNull();
    await expect(
      collections.updateCollection(fresh.id, { name: "User-Renamed" }),
    ).resolves.toMatchObject({ name: "User-Renamed" });
  });
});

afterAll(() => {
  rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
});
