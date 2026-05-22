import { describe, it, expect, vi, beforeEach } from "vitest";

const fileStore = new Map();

// Per-test reference-sheet "what exists on disk" — keys are filenames the
// referenceSheetImageRef preservation guard / pruner asks about. Default
// behavior is "non-empty filename resolves" so existing tests using fake
// names like 'sheet-B.png' still pass; the stale-prune test overrides
// resolveImageRef to return null for the stale filename.
const refSheetFilesByName = new Map();
vi.mock("../lib/fileUtils.js", () => ({
tryReadFile: vi.fn().mockResolvedValue(null),
  PATHS: { data: "/mock/data" },
  ensureDir: vi.fn().mockResolvedValue(undefined),
  atomicWrite: vi.fn(async (path, data) => {
    fileStore.set(path, data);
  }),
  readJSONFile: vi.fn(async (path, fallback) =>
    fileStore.has(path) ? fileStore.get(path) : fallback,
  ),
  // mustExist: true → return a non-null path when the filename either
  // appears in refSheetFilesByName or has no explicit "missing" entry.
  // Tests opt into "this file is gone" by calling
  // refSheetFilesByName.set('foo.png', null).
  resolveImageRef: vi.fn((ref) => {
    if (typeof ref !== 'string' || !ref) return null;
    if (refSheetFilesByName.has(ref)) return refSheetFilesByName.get(ref);
    return `/mock/refs/${ref}`;
  }),
}));

let uuidCounter = 0;
vi.mock("crypto", async () => {
  const actual = await vi.importActual("crypto");
  return { ...actual, randomUUID: () => `uuid-${++uuidCounter}` };
});

const svc = await import("./universeBuilder.js");

// Default universe with non-empty influences. Override `influences` for tests
// that need isolation from the seed tokens.
//
// The seed uses `outfits` (a custom category) rather than the legacy default
// `characters` bucket — the latter was retired in schema v4 and any variations
// under it get folded into universe.characters[] (canon) on sanitize. Using a
// custom name keeps the 2-bucket / 3-variation scenario these tests rely on.
const seedWorld = async (overrides = {}) =>
  svc.createUniverse({
    name: "Moebius SciFi",
    starterPrompt: "moebius and scavengers reign meets prophet",
    influences: {
      embrace: ["moebius linework", "scavengers reign palette"],
      avoid: ["blurry", "lowres"],
    },
    categories: {
      landscapes: {
        variations: [
          { label: "Crystal Canyon", prompt: "crystalline canyon, alien sun" },
          { label: "Sand Sea", prompt: "endless sand sea, dunes" },
        ],
      },
      outfits: {
        variations: [
          {
            label: "Scavenger",
            prompt: "lone scavenger figure, weathered cloak",
          },
        ],
      },
    },
    ...overrides,
  });

describe("universeBuilder service", () => {
  beforeEach(() => {
    fileStore.clear();
    uuidCounter = 0;
  });

  it("listUniverses returns [] for fresh state", async () => {
    expect(await svc.listUniverses()).toEqual([]);
  });

  it("createUniverse persists with sanitized categories + kind tags", async () => {
    const w = await seedWorld();
    expect(w.id).toBe("uuid-1");
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
    const collections = await import("./mediaCollections.js");
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

  it("deleteUniverse unlinks linked media collections (releases the rename-lock)", async () => {
    const collections = await import("./mediaCollections.js");
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

  describe("synthesizeCanonPrompt", () => {
    it("hand-authored prompt wins over field synthesis", () => {
      expect(svc.synthesizeCanonPrompt("characters", {
        name: "Mira",
        prompt: "custom prompt",
        physicalDescription: "weathered scavenger",
      })).toBe("custom prompt");
    });

    it("synthesizes from identifier + RICH descriptor for characters", () => {
      expect(svc.synthesizeCanonPrompt("characters", {
        name: "Mira",
        physicalDescription: "weathered scavenger",
        role: "protagonist",
      })).toBe("Mira — weathered scavenger. protagonist");
    });

    it("synthesizes from identifier + RICH descriptor for settings (capitalized prefixes)", () => {
      expect(svc.synthesizeCanonPrompt("places", {
        name: "Foundry City",
        description: "vast smelting works",
        palette: "rust + bone",
        era: "post-collapse",
        weather: "ash haze",
        recurringDetails: "broken statue at center",
      })).toBe("Foundry City — vast smelting works. Palette: rust + bone. Era: post-collapse. Weather: ash haze. broken statue at center");
    });

    it("falls back to slugline as identifier for settings without name", () => {
      expect(svc.synthesizeCanonPrompt("places", {
        slugline: "INT. FOUNDRY — DAY",
        description: "ore furnace",
      })).toBe("INT. FOUNDRY — DAY — ore furnace");
    });

    it("returns identifier alone when no descriptive fields are set", () => {
      expect(svc.synthesizeCanonPrompt("characters", { name: "Mira" })).toBe("Mira");
    });

    it("returns empty string for null entry", () => {
      expect(svc.synthesizeCanonPrompt("characters", null)).toBe("");
    });
  });

  describe("buildUniverseStyleContext", () => {
    const universe = {
      logline: "A foundry city goes silent.",
      premise: "post-collapse industrial sprawl",
      styleNotes: "moebius linework, ash palette",
      influences: { embrace: ["moebius linework", "cel-shading"], avoid: ["blurry"] },
    };

    it("returns '' for null universe", () => {
      expect(svc.buildUniverseStyleContext(null)).toBe("");
    });

    it("returns '' when no fields populate", () => {
      expect(svc.buildUniverseStyleContext({})).toBe("");
    });

    it("default options render bare `# Universe context` header with logline + styleNotes + embrace", () => {
      expect(svc.buildUniverseStyleContext(universe))
        .toBe("\n# Universe context\nLOGLINE: A foundry city goes silent.\n\nSTYLE NOTES: moebius linework, ash palette\n\nEMBRACE INFLUENCES: moebius linework, cel-shading\n");
    });

    it("headerSuffix appears after `Universe context — `", () => {
      const out = svc.buildUniverseStyleContext(
        { logline: "X" },
        { headerSuffix: "keep the new canon entry consistent with this established setting" },
      );
      expect(out).toBe("\n# Universe context — keep the new canon entry consistent with this established setting\nLOGLINE: X\n");
    });

    it("includePremise inserts PREMISE between LOGLINE and STYLE NOTES", () => {
      const out = svc.buildUniverseStyleContext(universe, { includePremise: true });
      expect(out.indexOf("LOGLINE:")).toBeLessThan(out.indexOf("PREMISE:"));
      expect(out.indexOf("PREMISE:")).toBeLessThan(out.indexOf("STYLE NOTES:"));
      expect(out).toContain("PREMISE: post-collapse industrial sprawl");
    });

    it("includeEmbrace:false suppresses the embrace line", () => {
      const out = svc.buildUniverseStyleContext(universe, { includeEmbrace: false });
      expect(out).not.toContain("EMBRACE INFLUENCES:");
      expect(out).toContain("LOGLINE:");
      expect(out).toContain("STYLE NOTES:");
    });

    it("escape:true collapses embedded newlines in styleNotes/logline", () => {
      const out = svc.buildUniverseStyleContext(
        { logline: "line1\nline2", styleNotes: "para1\n\npara2" },
        { escape: true },
      );
      expect(out).toContain("LOGLINE: line1 line2");
      expect(out).toContain("STYLE NOTES: para1 para2");
    });

    it("escape:false (default) preserves embedded newlines verbatim", () => {
      const out = svc.buildUniverseStyleContext({ logline: "line1\nline2" });
      expect(out).toContain("LOGLINE: line1\nline2");
    });

    it("returns '' when only premise is set but includePremise is false (the default)", () => {
      expect(svc.buildUniverseStyleContext({ premise: "p" })).toBe("");
    });

    it("expand-variations call shape (includePremise + includeEmbrace:false + headerSuffix) renders only logline/premise/styleNotes", () => {
      const out = svc.buildUniverseStyleContext(
        { logline: "L", premise: "P", styleNotes: "S", influences: { embrace: ["should-not-appear"] } },
        {
          includePremise: true,
          includeEmbrace: false,
          headerSuffix: "keep new variations consistent with this established setting",
        },
      );
      expect(out).toBe("\n# Universe context — keep new variations consistent with this established setting\nLOGLINE: L\n\nPREMISE: P\n\nSTYLE NOTES: S\n");
    });
  });

  describe("compilePrompts", () => {
    it("returns one prompt per variation across selected categories with style prefix", async () => {
      const w = await seedWorld();
      const compiled = svc.compilePrompts(w);
      // 2 landscapes + 1 outfit = 3 (other categories empty)
      expect(compiled).toHaveLength(3);
      // Style prefix uses `. ` separator (composeStyledPrompt convention,
      // shared with the scenePrompt composer in the client).
      expect(compiled[0].prompt).toBe(
        "moebius linework, scavengers reign palette. crystalline canyon, alien sun",
      );
      expect(compiled[0].category).toBe("landscapes");
      expect(compiled[0].label).toBe("Crystal Canyon");
      expect(compiled[0].negativePrompt).toBe("blurry, lowres");
    });

    it("includes custom categories by default", async () => {
      const w = await seedWorld({
        categories: {
          colonies: {
            variations: [
              {
                label: "Canopy Symbiotes",
                prompt:
                  "leaf-fiber clothing reference sheet, sap resin closures",
              },
            ],
          },
        },
      });
      const compiled = svc.compilePrompts(w);
      expect(compiled).toHaveLength(1);
      expect(compiled[0]).toMatchObject({
        category: "colonies",
        label: "Canopy Symbiotes",
      });
    });

    it("respects batchPerVariation", async () => {
      const w = await seedWorld();
      const compiled = svc.compilePrompts(w, { batchPerVariation: 3 });
      expect(compiled).toHaveLength(9); // 3 variations × 3 batch
      expect(compiled.filter((c) => c.label === "Crystal Canyon")).toHaveLength(
        3,
      );
    });

    it("selection: array filters by label (case-insensitive)", async () => {
      const w = await seedWorld();
      const compiled = svc.compilePrompts(w, {
        selection: { landscapes: ["crystal canyon"], outfits: "all" },
      });
      // 1 landscape (filtered) + 1 outfit (all) = 2
      expect(compiled).toHaveLength(2);
      expect(compiled.map((c) => c.label).sort()).toEqual([
        "Crystal Canyon",
        "Scavenger",
      ]);
    });

    it("selection: missing key skips category", async () => {
      const w = await seedWorld();
      const compiled = svc.compilePrompts(w, {
        selection: { landscapes: "all" },
      });
      expect(compiled).toHaveLength(2);
      expect(compiled.every((c) => c.category === "landscapes")).toBe(true);
    });

    it("selection supports custom category keys", async () => {
      const w = await seedWorld({
        categories: {
          raider_clans: {
            variations: [
              {
                label: "Wake Jackals",
                prompt: "clean scavenger raider outfit board",
              },
              {
                label: "Hull Vultures",
                prompt: "pressure-ring pirate boarding gear",
              },
            ],
          },
        },
      });
      const compiled = svc.compilePrompts(w, {
        selection: { raider_clans: ["wake jackals"] },
      });
      expect(compiled).toHaveLength(1);
      expect(compiled[0].label).toBe("Wake Jackals");
    });

    it("layers per-batch overrides on top of universe influences", async () => {
      const w = await seedWorld();
      const compiled = svc.compilePrompts(w, {
        selection: { landscapes: ["crystal canyon"] },
        extraStyle: "high contrast",
        extraNegative: "low quality",
        stylePresetPrompt: "noir cinematography",
        stylePresetNegative: "color photo",
      });
      expect(compiled).toHaveLength(1);
      // Baseline + preset + extra are comma-joined into the stylePreset prefix
      // and composeStyledPrompt sticks ". " between style and variation.
      expect(compiled[0].prompt).toBe(
        "moebius linework, scavengers reign palette, noir cinematography, high contrast. crystalline canyon, alien sun",
      );
      // Negative parts are comma-joined; composeStyledPrompt also adds a comma
      // when the user negative is non-empty, but here userNegative is empty so
      // we just see baseline + preset + extra.
      expect(compiled[0].negativePrompt).toBe(
        "blurry, lowres, color photo, low quality",
      );
    });

    it("override fields default to baseline influences when omitted", async () => {
      const w = await seedWorld();
      const compiled = svc.compilePrompts(w, {
        selection: { landscapes: ["crystal canyon"] },
      });
      expect(compiled[0].prompt).toBe(
        "moebius linework, scavengers reign palette. crystalline canyon, alien sun",
      );
      expect(compiled[0].negativePrompt).toBe("blurry, lowres");
    });

    it("clamps batchPerVariation to 1..20", async () => {
      const w = await seedWorld();
      // 0 → 1
      expect(svc.compilePrompts(w, { batchPerVariation: 0 })).toHaveLength(3);
      // 100 → 20
      const big = svc.compilePrompts(w, { batchPerVariation: 100 });
      expect(big).toHaveLength(60); // 3 × 20
    });

    it("can compile composite sheets without atomic variations", async () => {
      const w = await seedWorld({
        categories: {},
        compositeSheets: [
          {
            label: "Canopy Symbiotes sheet",
            prompt:
              "clean costume reference sheet, lineup, materials, fasteners, palette",
          },
          {
            label: "Gas-Giant Drifters sheet",
            prompt:
              "clean costume reference sheet, pressure collars, clips, palette",
          },
        ],
      });
      const compiled = svc.compilePrompts(w, { promptMode: "sheets" });
      expect(compiled).toHaveLength(2);
      expect(compiled[0]).toMatchObject({
        category: "composite_sheets",
        label: "Canopy Symbiotes sheet",
        prompt:
          "moebius linework, scavengers reign palette. clean costume reference sheet, lineup, materials, fasteners, palette",
      });
    });

    it("tags universe pitch poster prompts separately from reference sheets", async () => {
      const w = await seedWorld({
        categories: {},
        compositeSheets: [
          {
            kind: "world_pitch_poster",
            label: "Universe pitch poster",
            prompt:
              "cinematic universe summary pitch poster, hero panorama, inset cultures, palette, themes",
          },
        ],
      });
      const compiled = svc.compilePrompts(w, { promptMode: "sheets" });
      expect(compiled).toHaveLength(1);
      expect(compiled[0]).toMatchObject({
        category: "world_pitch_posters",
        label: "Universe pitch poster",
      });
    });

    it("can compile atomic variations and composite sheets together", async () => {
      const w = await seedWorld({
        compositeSheets: [
          {
            label: "Gas-Giant Drifters sheet",
            prompt:
              "clean costume reference sheet, pressure collars, clips, palette",
          },
        ],
      });
      const compiled = svc.compilePrompts(w, { promptMode: "all" });
      expect(compiled).toHaveLength(4); // 3 atomic variations + 1 composite
      expect(compiled.map((p) => p.category)).toContain("composite_sheets");
    });

    describe("canon", () => {
      // Compile canon directly off a draft (createUniverse doesn't accept canon —
      // it lands via the canon-extract / refine path or the expand auto-save).
      // The synthesis path doesn't touch persistence, so a literal world shape
      // is enough.
      const canonWorld = () => ({
        influences: {
          embrace: ["moebius linework"],
          avoid: ["blurry"],
        },
        characters: [
          {
            name: "Mira",
            physicalDescription: "weathered scavenger, dust mask, copper goggles",
            role: "protagonist",
          },
          { name: "Vex", physicalDescription: "tall, scarred, plate-armor smith" },
        ],
        places: [
          {
            name: "Foundry City",
            slugline: "EXT. FOUNDRY CITY — DAY",
            description: "vast smelting works at the canyon rim",
            palette: "rust + bone",
          },
        ],
        objects: [
          { name: "Brass Compass", description: "always points away from home" },
        ],
      });

      it("synthesizes canon prompts from name + descriptive fields with style prefix", () => {
        const w = canonWorld();
        const compiled = svc.compilePrompts(w, {
          promptMode: "canon",
          canonSelection: { characters: "all", places: "all", objects: "all" },
        });
        // 2 characters + 1 setting + 1 object = 4
        expect(compiled).toHaveLength(4);
        const mira = compiled.find((c) => c.label === "Mira");
        expect(mira.category).toBe("canon:characters");
        expect(mira.prompt).toBe(
          "moebius linework. Mira — weathered scavenger, dust mask, copper goggles. protagonist",
        );
        expect(mira.negativePrompt).toBe("blurry");
        const place = compiled.find((c) => c.label === "Foundry City");
        expect(place.category).toBe("canon:places");
        expect(place.prompt).toContain("Foundry City");
        expect(place.prompt).toContain("Palette: rust + bone");
      });

      it("canonSelection: missing trunk skips it", () => {
        const w = canonWorld();
        const compiled = svc.compilePrompts(w, {
          promptMode: "canon",
          canonSelection: { places: "all" },
        });
        expect(compiled).toHaveLength(1);
        expect(compiled[0].category).toBe("canon:places");
      });

      it("canonSelection: array filters by name (case-insensitive)", () => {
        const w = canonWorld();
        const compiled = svc.compilePrompts(w, {
          promptMode: "canon",
          canonSelection: { characters: ["mira"] },
        });
        expect(compiled).toHaveLength(1);
        expect(compiled[0].label).toBe("Mira");
      });

      it("synthesizes a settings prompt from slugline-only entries (no name)", () => {
        // The bible sanitizer accepts a setting whose only identifier is a
        // slugline (name field empty). synthesizeCanonPrompt must fall back
        // to slugline as the identifier seed so such entries don't silently
        // synthesize to '' and get skipped at render time.
        const w = canonWorld();
        w.places.push({
          // No name — only a slugline identifier + description.
          slugline: "INT. OLD ARCHIVE — NIGHT",
          description: "lantern-lit shelves of ledgers",
        });
        const compiled = svc.compilePrompts(w, {
          promptMode: "canon",
          canonSelection: { places: "all" },
        });
        // Two settings now: the named Foundry City + the slugline-only Archive.
        expect(compiled).toHaveLength(2);
        const archive = compiled.find((c) => c.label === "INT. OLD ARCHIVE — NIGHT");
        expect(archive).toBeTruthy();
        expect(archive.prompt).toContain("INT. OLD ARCHIVE — NIGHT");
        expect(archive.prompt).toContain("lantern-lit shelves of ledgers");
      });

      it("canonSelection: settings also matches by slugline", () => {
        const w = canonWorld();
        const compiled = svc.compilePrompts(w, {
          promptMode: "canon",
          canonSelection: { places: ["EXT. FOUNDRY CITY — DAY"] },
        });
        expect(compiled).toHaveLength(1);
        expect(compiled[0].label).toBe("Foundry City");
      });

      it("canonSelection: slugline matching is settings-only (characters/objects ignore stray slugline)", () => {
        // A stray `slugline` on a character or object should NOT participate
        // in canon-selection matching — slugline is part of the settings
        // schema only. This guards against accidental cross-trunk selection
        // when an upstream tool mis-tags an entry.
        const w = {
          ...canonWorld(),
          characters: [
            {
              name: "Ghost",
              slugline: "should-not-match-on-character",
              physicalDescription: "spectral",
            },
          ],
          objects: [
            {
              name: "Shard",
              slugline: "should-not-match-on-object",
              description: "humming crystal",
            },
          ],
        };
        const charsCompiled = svc.compilePrompts(w, {
          promptMode: "canon",
          canonSelection: { characters: ["should-not-match-on-character"] },
        });
        expect(charsCompiled).toHaveLength(0);
        const objsCompiled = svc.compilePrompts(w, {
          promptMode: "canon",
          canonSelection: { objects: ["should-not-match-on-object"] },
        });
        expect(objsCompiled).toHaveLength(0);
        // Sanity — name still matches.
        const nameMatched = svc.compilePrompts(w, {
          promptMode: "canon",
          canonSelection: { characters: ["Ghost"], objects: ["Shard"] },
        });
        expect(nameMatched).toHaveLength(2);
      });

      it("entry.prompt wins over synthesized fields", () => {
        const w = {
          ...canonWorld(),
          characters: [
            {
              name: "Mira",
              physicalDescription: "ignored",
              prompt: "explicit hand-authored prompt",
            },
          ],
        };
        const compiled = svc.compilePrompts(w, {
          promptMode: "canon",
          canonSelection: { characters: "all" },
        });
        expect(compiled).toHaveLength(1);
        expect(compiled[0].prompt).toBe(
          "moebius linework. explicit hand-authored prompt",
        );
      });

      it("skips entries with no name and no descriptive content", () => {
        const w = { ...canonWorld(), characters: [{}, { name: "Mira" }] };
        const compiled = svc.compilePrompts(w, {
          promptMode: "canon",
          canonSelection: { characters: "all" },
        });
        expect(compiled).toHaveLength(1);
        expect(compiled[0].label).toBe("Mira");
      });

      it("promptMode=all compiles variations + sheets + canon together", async () => {
        const w = await seedWorld({
          compositeSheets: [
            { label: "Sheet", prompt: "clean reference sheet" },
          ],
        });
        // Layer canon directly onto the persisted world for this scenario.
        w.characters = [
          { name: "Mira", physicalDescription: "weathered scavenger" },
        ];
        const compiled = svc.compilePrompts(w, {
          promptMode: "all",
          canonSelection: { characters: "all" },
        });
        // 3 variations + 1 sheet + 1 canon = 5
        expect(compiled).toHaveLength(5);
        expect(compiled.map((c) => c.category)).toContain("canon:characters");
      });

      it("respects batchPerVariation for canon", () => {
        const w = canonWorld();
        const compiled = svc.compilePrompts(w, {
          promptMode: "canon",
          canonSelection: { characters: ["mira"] },
          batchPerVariation: 3,
        });
        expect(compiled).toHaveLength(3);
        expect(compiled.every((c) => c.label === "Mira")).toBe(true);
      });

      it("canon promptMode without canonSelection produces no prompts", () => {
        const w = canonWorld();
        const compiled = svc.compilePrompts(w, { promptMode: "canon" });
        expect(compiled).toEqual([]);
      });
    });
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
    it("backfills canon arrays from categories on first read + stamps the current schema version", async () => {
      fileStore.set("/mock/data/universe-builder.json", {
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
      fileStore.set("/mock/data/universe-builder.json", {
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
      fileStore.set("/mock/data/universe-builder.json", { universes: [renamed], runs: [] });
      const third = (await svc.listUniverses())[0];
      expect(third.characters.length).toBe(1);
      expect(third.characters[0].name).toBe("Alex Smith");
    });

    it("backfill does not overwrite a pre-existing canon entry sharing a variation label", async () => {
      fileStore.set("/mock/data/universe-builder.json", {
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
      fileStore.set("/mock/data/universe-builder.json", {
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
      fileStore.set("/mock/data/universe-builder.json", {
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
      fileStore.set("/mock/data/universe-builder.json", {
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
      fileStore.set("/mock/data/universe-builder.json", {
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

  describe("sanitizers", () => {
    it("drops malformed variations on read", async () => {
      // Manually plant invalid state — sanitizeTemplate strips it on read.
      fileStore.set("/mock/data/universe-builder.json", {
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
  // server-side" (CLAUDE.md). Each updateUniverse() now goes through a
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
      // Per CLAUDE.md: a Map<id, Promise> is NOT enough — both universes
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
      const slot = await import("./universeCharacterSheetSlot.js");
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
      const slot = await import("./universeCharacterSheetSlot.js");
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
      const slot = await import("./universeCharacterSheetSlot.js");
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
});
