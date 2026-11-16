/**
 * compile.test.js
 *
 * compile.js prompt synthesis/compilation and the universe style context. Split from universeBuilder.test.js (#16214); shared
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

const { TEST_DATA_ROOT, seedWorld } = h;
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
      // Each block PortOS folds around the variation is listed; the batch's
      // own negative is the user's text, so it is not (#11317).
      expect(compiled[0].promptAdditions).toEqual([
        { id: "universe-style", label: "Universe style", text: "moebius linework, scavengers reign palette" },
        { id: "style-preset", label: "Style preset", text: "noir cinematography" },
        { id: "extra-style", label: "Batch extra style", text: "high contrast" },
        { id: "universe-avoid", label: "Universe avoid (negative prompt)", text: "blurry, lowres" },
        { id: "style-preset-negatives", label: "Style preset negatives", text: "color photo" },
      ]);
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
});

afterAll(() => {
  rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
});
