import { describe, it, expect, vi, beforeEach } from "vitest";

const fileStore = new Map();

vi.mock("../lib/fileUtils.js", () => ({
  PATHS: { data: "/mock/data" },
  ensureDir: vi.fn().mockResolvedValue(undefined),
  atomicWrite: vi.fn(async (path, data) => {
    fileStore.set(path, data);
  }),
  readJSONFile: vi.fn(async (path, fallback) =>
    fileStore.has(path) ? fileStore.get(path) : fallback,
  ),
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
        label: "Rib-Cage Nomads",
        prompt: "reference sheet, layered sailcloth, bone toggles",
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
        kind: "reference_sheet",
        label: "Gas-Giant Drifters costume sheet",
        prompt:
          "Create a clean illustrated costume reference sheet with five figures, materials swatches, fasteners, accessories, and color palette strip.",
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
        kind: "world_pitch_poster",
        label: "Universe summary concept pitch poster",
        prompt:
          "Create a cinematic universe summary concept pitch poster with hero panorama, inset environments, cultures, creatures, visual language, color palette, materials, light atmosphere, and theme icons.",
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
    it("round-trips a `locked: true` flag on variations", async () => {
      const w = await seedWorld({
        categories: {
          landscapes: {
            variations: [
              {
                label: "Pinned canyon",
                prompt: "pinned canyon prompt",
                locked: true,
              },
              { label: "Open canyon", prompt: "open canyon prompt" },
            ],
          },
        },
      });
      const vs = w.categories.landscapes.variations;
      expect(vs.find((v) => v.label === "Pinned canyon").locked).toBe(true);
      expect(vs.find((v) => v.label === "Open canyon").locked).toBeUndefined();
    });

    it("drops non-true `locked` values rather than recording them", async () => {
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
      expect(labels.A).toBeUndefined();
      expect(labels.B).toBeUndefined();
      expect(labels.C).toBeUndefined();
    });

    it("round-trips a `locked: true` flag on composite sheets", async () => {
      const w = await seedWorld({
        compositeSheets: [
          {
            label: "Pinned poster",
            prompt: "pinned poster prompt long enough",
            kind: "world_pitch_poster",
            locked: true,
          },
          { label: "Open sheet", prompt: "open sheet prompt long enough" },
        ],
      });
      expect(
        w.compositeSheets.find((s) => s.label === "Pinned poster").locked,
      ).toBe(true);
      expect(
        w.compositeSheets.find((s) => s.label === "Open sheet").locked,
      ).toBeUndefined();
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
});
