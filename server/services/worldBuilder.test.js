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

const svc = await import("./worldBuilder.js");

const seedWorld = async (overrides = {}) =>
  svc.createWorld({
    name: "Moebius SciFi",
    starterPrompt: "moebius and scavengers reign meets prophet",
    stylePrompt: "moebius linework, scavengers reign palette",
    negativePrompt: "blurry, lowres",
    categories: {
      landscapes: {
        variations: [
          { label: "Crystal Canyon", prompt: "crystalline canyon, alien sun" },
          { label: "Sand Sea", prompt: "endless sand sea, dunes" },
        ],
      },
      characters: {
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

describe("worldBuilder service", () => {
  beforeEach(() => {
    fileStore.clear();
    uuidCounter = 0;
  });

  it("listWorlds returns [] for fresh state", async () => {
    expect(await svc.listWorlds()).toEqual([]);
  });

  it("createWorld persists with sanitized categories", async () => {
    const w = await seedWorld();
    expect(w.id).toBe("uuid-1");
    expect(w.name).toBe("Moebius SciFi");
    // All five categories materialized even when only two were provided.
    for (const c of svc.WORLD_CATEGORIES) {
      expect(w.categories[c]).toBeDefined();
      expect(Array.isArray(w.categories[c].variations)).toBe(true);
    }
    expect(w.categories.landscapes.variations).toHaveLength(2);
    expect(w.categories.characters.variations).toHaveLength(1);
    expect(w.categories.environments.variations).toHaveLength(0);
  });

  it("createWorld preserves custom world-building categories", async () => {
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

  it("createWorld persists composite sheet prompts separately from categories", async () => {
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

  it("createWorld persists world pitch poster prompts separately from categories", async () => {
    const w = await seedWorld({
      compositeSheets: [
        {
          kind: "world_pitch_poster",
          label: "World summary concept pitch poster",
          prompt:
            "Create a cinematic world summary concept pitch poster with hero panorama, inset environments, cultures, creatures, visual language, color palette, materials, light atmosphere, and theme icons.",
        },
      ],
    });
    expect(w.compositeSheets).toEqual([
      {
        kind: "world_pitch_poster",
        label: "World summary concept pitch poster",
        prompt:
          "Create a cinematic world summary concept pitch poster with hero panorama, inset environments, cultures, creatures, visual language, color palette, materials, light atmosphere, and theme icons.",
      },
    ]);
  });

  it("createWorld rejects empty name", async () => {
    await expect(svc.createWorld({ name: "" })).rejects.toThrow(
      /name is required/,
    );
  });

  it("createWorld persists narrative bible fields (logline / premise / styleNotes)", async () => {
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

  it("updateWorld patches narrative bible fields independently of categories", async () => {
    const w = await seedWorld({ logline: "original logline" });
    const patched = await svc.updateWorld(w.id, {
      logline: "new logline",
      premise: "new premise",
      styleNotes: "new style notes",
    });
    expect(patched.logline).toBe("new logline");
    expect(patched.premise).toBe("new premise");
    expect(patched.styleNotes).toBe("new style notes");
    // Untouched (existing) data preserved.
    expect(patched.categories.landscapes.variations).toHaveLength(2);
    expect(patched.stylePrompt).toBe(w.stylePrompt);
  });

  it("createWorld trims bible fields to their max length", async () => {
    const w = await seedWorld({
      logline: "x".repeat(svc.LOGLINE_MAX + 50),
      premise: "y".repeat(svc.PREMISE_MAX + 50),
      styleNotes: "z".repeat(svc.STYLE_NOTES_MAX + 50),
    });
    expect(w.logline).toHaveLength(svc.LOGLINE_MAX);
    expect(w.premise).toHaveLength(svc.PREMISE_MAX);
    expect(w.styleNotes).toHaveLength(svc.STYLE_NOTES_MAX);
  });

  it("updateWorld merges partial patches", async () => {
    const w = await seedWorld();
    const patched = await svc.updateWorld(w.id, {
      name: "Renamed",
      stylePrompt: "new style",
    });
    expect(patched.name).toBe("Renamed");
    expect(patched.stylePrompt).toBe("new style");
    // Untouched fields preserved.
    expect(patched.starterPrompt).toBe(w.starterPrompt);
    expect(patched.categories.landscapes.variations).toHaveLength(2);
  });

  it("updateWorld throws NOT_FOUND for unknown id", async () => {
    await expect(
      svc.updateWorld("no-such", { name: "X" }),
    ).rejects.toMatchObject({ code: svc.ERR_NOT_FOUND });
  });

  it("deleteWorld removes the world and its runs", async () => {
    const w = await seedWorld();
    await svc.recordRun({
      id: "run-1",
      worldId: w.id,
      collectionId: "col-1",
      jobIds: ["j1"],
      promptCount: 3,
    });
    expect(await svc.listRuns(w.id)).toHaveLength(1);
    await svc.deleteWorld(w.id);
    expect(await svc.listWorlds()).toEqual([]);
    expect(await svc.listRuns(w.id)).toEqual([]);
  });

  describe("compilePrompts", () => {
    it("returns one prompt per variation across selected categories with style prefix", async () => {
      const w = await seedWorld();
      const compiled = svc.compilePrompts(w);
      // 2 landscapes + 1 character = 3 (other categories empty)
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
        selection: { landscapes: ["crystal canyon"], characters: "all" },
      });
      // 1 landscape (filtered) + 1 character (all) = 2
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

    it("tags world pitch poster prompts separately from reference sheets", async () => {
      const w = await seedWorld({
        categories: {},
        compositeSheets: [
          {
            kind: "world_pitch_poster",
            label: "World pitch poster",
            prompt:
              "cinematic world summary pitch poster, hero panorama, inset cultures, palette, themes",
          },
        ],
      });
      const compiled = svc.compilePrompts(w, { promptMode: "sheets" });
      expect(compiled).toHaveLength(1);
      expect(compiled[0]).toMatchObject({
        category: "world_pitch_posters",
        label: "World pitch poster",
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
  });

  describe("influences", () => {
    it("round-trips embrace + avoid lists through createWorld", async () => {
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
      const w = await seedWorld({ influences: undefined });
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

    it("updateWorld replaces influence lists wholesale (does not merge)", async () => {
      const w = await seedWorld({
        influences: { embrace: ["A", "B"], avoid: ["X"] },
      });
      const patched = await svc.updateWorld(w.id, {
        influences: { embrace: ["C"] },
      });
      // Wholesale replace: avoid is gone because the patch didn't carry it.
      expect(patched.influences.embrace).toEqual(["C"]);
      expect(patched.influences.avoid).toEqual([]);
    });

    it("compilePrompts deterministically prepends embrace to prompt + avoid to negative, deduped", async () => {
      const w = await seedWorld({
        // stylePrompt already mentions one of the embraces — dedupe should
        // ensure it doesn't appear twice in the rendered prompt.
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
      // Embrace tokens prefix the existing style tokens; the duplicate
      // "cel-shading" only appears once.
      expect(
        compiled[0].prompt.startsWith(
          "Moebius, cel-shading, ink, dust palette",
        ),
      ).toBe(true);
      expect((compiled[0].prompt.match(/cel-shading/g) || []).length).toBe(1);
      // Negative: avoid tokens prefix existing negatives, deduped against "lowres".
      expect(
        compiled[0].negativePrompt.startsWith("ghibli painterly, lowres"),
      ).toBe(true);
      expect((compiled[0].negativePrompt.match(/lowres/g) || []).length).toBe(
        1,
      );
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
      const patched = await svc.updateWorld(w.id, {
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
      // sanitizer now splits it into two so existing on-disk worlds keep working
      // without a data migration step.
      const w = await seedWorld({ locked: { influences: true, premise: true } });
      expect(w.locked).toEqual({
        premise: true,
        influencesEmbrace: true,
        influencesAvoid: true,
      });
    });
  });

  describe("sanitizers", () => {
    it("drops malformed variations on read", async () => {
      // Manually plant invalid state — sanitizeTemplate strips it on read.
      fileStore.set("/mock/data/world-builder.json", {
        worlds: [
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
      const list = await svc.listWorlds();
      expect(list[0].categories.landscapes.variations).toHaveLength(1);
      expect(list[0].categories.landscapes.variations[0].label).toBe("Good");
    });
  });
});
