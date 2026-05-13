import { describe, it, expect } from "vitest";
import { __testing } from "./worldBuilderExpand.js";
import { WORLD_CATEGORIES } from "./worldBuilder.js";

const {
  extractJson,
  normalizeCategories,
  normalizeCompositeSheets,
  buildExpansionPrompt,
} = __testing;
// Anchor the legacy assertions on the static body of the prompt — the only
// dynamic substitutions are the starter idea + (optional) influences section.
const EXPANSION_PROMPT = buildExpansionPrompt({
  starterPrompt: "fixture starter",
});

describe("worldBuilderExpand.extractJson", () => {
  it("parses a raw JSON object", () => {
    const obj = {
      stylePrompt: "a, b, c",
      negativePrompt: "blur",
      categories: {},
    };
    expect(extractJson(JSON.stringify(obj))).toEqual(obj);
  });

  it("strips ```json fences", () => {
    const fenced = '```json\n{"stylePrompt":"x","categories":{}}\n```';
    expect(extractJson(fenced)).toEqual({ stylePrompt: "x", categories: {} });
  });

  it("strips bare ``` fences", () => {
    const fenced = '```\n{"stylePrompt":"x"}\n```';
    expect(extractJson(fenced)).toEqual({ stylePrompt: "x" });
  });

  it("skips a preamble before the first { … } block", () => {
    const raw =
      'Here is the JSON you asked for:\n{"stylePrompt":"x","negativePrompt":"y"}\nHope this helps!';
    expect(extractJson(raw)).toEqual({ stylePrompt: "x", negativePrompt: "y" });
  });

  it("rejects empty / non-string input", () => {
    expect(() => extractJson("")).toThrow(/Empty LLM response/);
    expect(() => extractJson(null)).toThrow(/Empty LLM response/);
    expect(() => extractJson(undefined)).toThrow(/Empty LLM response/);
  });

  it("throws when no JSON object can be parsed", () => {
    expect(() => extractJson("totally bogus output, no braces")).toThrow();
    expect(() => extractJson("{ this is not valid json")).toThrow();
  });

  it("replaces literal [...] placeholders with empty arrays so the rest parses", () => {
    const raw =
      '{"stylePrompt":"x","categories":{"vehicles":{"variations":[...]}}}';
    const out = extractJson(raw);
    expect(out.stylePrompt).toBe("x");
    expect(out.categories.vehicles.variations).toEqual([]);
  });

  it("skips a pseudo-JSON schema example in echoed prompt and parses the real response (Codex CLI)", () => {
    // Codex CLI echoes the user prompt back to stdout before printing the model's
    // response. The prompt contains a JSON-shaped schema example using bare
    // identifiers as placeholder values — its braces balance but its contents
    // are not valid JSON. Earlier extractJson grabbed the first balanced block
    // and crashed; it should now fall through to the next block.
    const raw = [
      "OpenAI Codex v0.128.0 (research preview)",
      "--------",
      "workdir: /tmp",
      "--------",
      "user",
      'Each variation has the shape { "label": string (max 80 chars), "prompt": string (max 400 chars, comma-separated tokens describing ONE specific subject) }.',
      "codex",
      '{"stylePrompt":"x","negativePrompt":"y","categories":{"vehicles":{"variations":[{"label":"a","prompt":"b"}]}}}',
      "tokens used",
      "2,787",
    ].join("\n");
    const out = extractJson(raw);
    expect(out.stylePrompt).toBe("x");
    expect(out.negativePrompt).toBe("y");
    expect(out.categories.vehicles.variations).toEqual([
      { label: "a", prompt: "b" },
    ]);
  });

  it("repairs Codex CLI orphan-brace corruption (`}}]` → `}]`) inside the response", () => {
    // Real-world: Codex produced `{"label":"...","prompt":"…blister"}}]}}}`
    // — an extra `}` snuck in between the variation's close-brace and the
    // array's `]`. extractJson must recover that to a parsed expansion shape.
    const badJson =
      '{"stylePrompt":"x","categories":{"vehicles":{"variations":[{"label":"a","prompt":"…blister"}}]}}}';
    const out = extractJson(badJson);
    expect(out.stylePrompt).toBe("x");
    expect(out.categories.vehicles.variations).toEqual([
      { label: "a", prompt: "…blister" },
    ]);
  });

  it("strips a trailing comma before `]` (common LLM mistake)", () => {
    const raw =
      '{"stylePrompt":"x","categories":{"landscapes":{"variations":[{"label":"a","prompt":"b"},]}}}';
    const out = extractJson(raw);
    expect(out.categories.landscapes.variations).toEqual([
      { label: "a", prompt: "b" },
    ]);
  });

  it("prefers a world-expansion-shaped object over an in-prompt JSON example", () => {
    // The actual prompt template includes literal JSON example variations:
    //   { "label": "Crystalline canyon basin", "prompt": "…" }
    // These are valid JSON and brace-balance cleanly, but they aren't the
    // response. extractJson must skip them and return the larger object that
    // has the world-expansion top-level keys.
    const raw = [
      "codex",
      '{ "label": "Crystalline canyon basin", "prompt": "vast crystalline canyon, salt flats" }',
      '{ "label": "Scrap-iron dune sea", "prompt": "rolling dunes of rusted scrap" }',
      "codex",
      '{"stylePrompt":"painterly","categories":{"landscapes":{"variations":[{"label":"Real","prompt":"real prompt"}]}}}',
    ].join("\n");
    const out = extractJson(raw);
    expect(out.stylePrompt).toBe("painterly");
    expect(out.categories.landscapes.variations).toEqual([
      { label: "Real", prompt: "real prompt" },
    ]);
  });

  it("wraps a JSON.parse failure in a 502 LLM_INVALID_JSON ServerError (no raw 500)", () => {
    let thrown;
    try {
      extractJson('{ "stylePrompt": "x", "broken');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect(thrown.status).toBe(502);
    expect(thrown.code).toBe("LLM_INVALID_JSON");
    expect(thrown.context?.details?.preview).toContain("broken");
  });
});

describe("worldBuilderExpand.normalizeCategories", () => {
  it("returns all canonical categories with empty variations on empty input", () => {
    const out = normalizeCategories({});
    for (const key of WORLD_CATEGORIES) {
      expect(out[key]).toEqual({ variations: [] });
    }
  });

  it("coerces a flat array of strings into label/prompt pairs", () => {
    const out = normalizeCategories({
      landscapes: ["Crystalline canyon basin", "Salt flat ruins"],
    });
    expect(out.landscapes.variations).toEqual([
      { label: "Crystalline canyon basin", prompt: "Crystalline canyon basin" },
      { label: "Salt flat ruins", prompt: "Salt flat ruins" },
    ]);
  });

  it("truncates long string-shape labels at 80 chars", () => {
    const longText = "x".repeat(200);
    const out = normalizeCategories({ characters: [longText] });
    expect(out.characters.variations[0].label).toHaveLength(80);
    expect(out.characters.variations[0].prompt).toBe(longText);
  });

  it("accepts the canonical { variations: [{label,prompt}] } shape", () => {
    const out = normalizeCategories({
      vehicles: {
        variations: [
          { label: "Walker mech", prompt: "rusted six-leg walker mech" },
        ],
      },
    });
    expect(out.vehicles.variations).toEqual([
      { label: "Walker mech", prompt: "rusted six-leg walker mech" },
    ]);
  });

  it("drops malformed variations with missing label or prompt", () => {
    const out = normalizeCategories({
      structures: {
        variations: [
          { label: "Tower", prompt: "spire of obsidian" }, // keep
          { label: "", prompt: "no label" }, // drop
          { label: "No prompt", prompt: "" }, // drop
          { label: 42, prompt: "numeric label" }, // drop (label not string)
          null, // drop
        ],
      },
    });
    expect(out.structures.variations).toEqual([
      { label: "Tower", prompt: "spire of obsidian" },
    ]);
  });

  it("preserves custom categories beyond WORLD_CATEGORIES", () => {
    const out = normalizeCategories({
      landscapes: { variations: [{ label: "A", prompt: "a" }] },
      "Raider / Pirate Clans": {
        variations: [
          { label: "Wake Jackals", prompt: "spare moebius scavenger raiders" },
        ],
      },
    });
    expect(out.landscapes.variations).toHaveLength(1);
    expect(out.raider_pirate_clans.variations).toEqual([
      { label: "Wake Jackals", prompt: "spare moebius scavenger raiders" },
    ]);
  });

  it("treats a non-object category as empty variations (not a crash)", () => {
    const out = normalizeCategories({ characters: "not an object" });
    expect(out.characters).toEqual({ variations: [] });
  });
});

describe("worldBuilderExpand.normalizeCompositeSheets", () => {
  it("keeps complete composite reference-sheet prompts", () => {
    const out = normalizeCompositeSheets([
      {
        label: "Gas-Giant Drifters costume sheet",
        prompt:
          "Create a clean illustrated costume reference sheet with five figures, material swatches, fasteners, accessories, color palette strip, and simple floating-platform background.",
      },
    ]);
    expect(out).toEqual([
      {
        kind: "reference_sheet",
        label: "Gas-Giant Drifters costume sheet",
        prompt:
          "Create a clean illustrated costume reference sheet with five figures, material swatches, fasteners, accessories, color palette strip, and simple floating-platform background.",
      },
    ]);
  });

  it("coerces string sheets into label/prompt pairs", () => {
    const out = normalizeCompositeSheets(["Canopy Symbiotes reference board"]);
    expect(out).toEqual([
      {
        kind: "reference_sheet",
        label: "Canopy Symbiotes reference board",
        prompt: "Canopy Symbiotes reference board",
      },
    ]);
  });

  it("preserves world pitch poster board kind", () => {
    const out = normalizeCompositeSheets([
      {
        kind: "world_pitch_poster",
        label: "World summary concept pitch poster",
        prompt:
          "Create a cinematic world summary concept pitch poster with hero panorama, inset environments, culture callouts, palette, materials, light atmosphere, and theme icons.",
      },
    ]);
    expect(out).toEqual([
      {
        kind: "world_pitch_poster",
        label: "World summary concept pitch poster",
        prompt:
          "Create a cinematic world summary concept pitch poster with hero panorama, inset environments, culture callouts, palette, materials, light atmosphere, and theme icons.",
      },
    ]);
  });

  it("falls back to reference_sheet for unknown kinds", () => {
    const out = normalizeCompositeSheets([
      {
        kind: "bogus_kind",
        label: "Mystery board",
        prompt:
          "A board of unknown lineage with figures, palette, materials, and atmosphere.",
      },
    ]);
    expect(out[0].kind).toBe("reference_sheet");
  });
});

describe("worldBuilderExpand.EXPANSION_PROMPT", () => {
  it("allows dynamic world-building buckets and reference-sheet domains", () => {
    expect(EXPANSION_PROMPT).toContain("Add, remove, or rename buckets");
    expect(EXPANSION_PROMPT).toContain("colonies, factions, tribes, species");
    expect(EXPANSION_PROMPT).toContain("clothing guides");
    expect(EXPANSION_PROMPT).toContain("raider_clans");
    expect(EXPANSION_PROMPT).toContain("compositeSheets");
    expect(EXPANSION_PROMPT).toContain("world_pitch_poster");
    expect(EXPANSION_PROMPT).toContain("world summary concept pitch poster");
    expect(EXPANSION_PROMPT).toContain("materials swatches");
  });

  it("asks the LLM to emit a narrative bible (logline / premise / styleNotes)", () => {
    // The pipeline pulls these straight into the New Series form, so the
    // contract has to stay in the prompt. If this assertion fails, double-
    // check that worldBuilderExpand.js still hydrates the three fields too.
    expect(EXPANSION_PROMPT).toContain("logline:");
    expect(EXPANSION_PROMPT).toContain("premise:");
    expect(EXPANSION_PROMPT).toContain("styleNotes:");
  });

  it("asks the LLM to emit structured influences alongside the prose prompts", () => {
    // The renderer prepends embrace / avoid lists deterministically, so the
    // schema contract must instruct the LLM to populate them.
    expect(EXPANSION_PROMPT).toContain("influences:");
    expect(EXPANSION_PROMPT).toContain('"embrace"');
    expect(EXPANSION_PROMPT).toContain('"avoid"');
  });

  it("omits the Influences input section when no influences are provided", () => {
    const out = buildExpansionPrompt({ starterPrompt: "seed" });
    expect(out).not.toContain("# Influences");
  });

  it("embeds provided influences as starter context", () => {
    const out = buildExpansionPrompt({
      starterPrompt: "seed",
      influences: {
        embrace: ["Moebius", "cel-shading"],
        avoid: ["Ghibli painterly"],
      },
    });
    expect(out).toContain("# Influences");
    expect(out).toContain("Embrace: Moebius, cel-shading");
    expect(out).toContain("Avoid: Ghibli painterly");
  });

  it("omits the Current world state section when no bible/prompt fields are provided", () => {
    const out = buildExpansionPrompt({ starterPrompt: "seed" });
    expect(out).not.toContain("# Current world state");
  });

  it("includes provided bible + prompt fields as Current world state context", () => {
    const out = buildExpansionPrompt({
      starterPrompt: "seed",
      priorLogline: "A foundry city goes silent.",
      priorPremise: "Three families inherit the silence.",
      priorStyleNotes: "Tarkovsky pacing, Moebius palette.",
      priorStylePrompt: "moebius linework, dust palette",
      priorNegativePrompt: "blurry, lowres",
    });
    expect(out).toContain("# Current world state");
    expect(out).toContain("LOGLINE: A foundry city goes silent.");
    expect(out).toContain("PREMISE: Three families inherit the silence.");
    expect(out).toContain("STYLE NOTES: Tarkovsky pacing, Moebius palette.");
    expect(out).toContain("STYLE PROMPT: moebius linework, dust palette");
    expect(out).toContain("NEGATIVE PROMPT: blurry, lowres");
  });

  it("flags locked fields with [LOCKED] and adds the must-preserve instruction", () => {
    const out = buildExpansionPrompt({
      starterPrompt: "seed",
      priorLogline: "Locked logline.",
      priorPremise: "Loose premise.",
      locked: { logline: true },
    });
    expect(out).toContain("LOGLINE [LOCKED]: Locked logline.");
    expect(out).toContain("PREMISE: Loose premise.");
    expect(out).not.toContain("PREMISE [LOCKED]");
    expect(out).toContain("Fields marked [LOCKED] MUST be echoed unchanged");
  });

  it("flags locked embrace influences with [LOCKED] on the Embrace line", () => {
    const out = buildExpansionPrompt({
      starterPrompt: "seed",
      influences: { embrace: ["Moebius"], avoid: ["Ghibli"] },
      locked: { influencesEmbrace: true },
    });
    expect(out).toMatch(/Embrace \[LOCKED\]: Moebius/);
    // Avoid is untagged when not locked.
    expect(out).toMatch(/Avoid: Ghibli/);
    expect(out).not.toMatch(/Avoid \[LOCKED\]/);
  });

  it("flags locked avoid influences independently of embrace", () => {
    const out = buildExpansionPrompt({
      starterPrompt: "seed",
      influences: { embrace: ["Moebius"], avoid: ["Ghibli"] },
      locked: { influencesAvoid: true },
    });
    expect(out).toMatch(/Embrace: Moebius/);
    expect(out).not.toMatch(/Embrace \[LOCKED\]/);
    expect(out).toMatch(/Avoid \[LOCKED\]: Ghibli/);
  });

  it("skips empty bible/prompt fields from Current world state", () => {
    const out = buildExpansionPrompt({
      starterPrompt: "seed",
      priorLogline: "Just a logline.",
      priorPremise: "",
      priorStyleNotes: "   ",
    });
    expect(out).toContain("LOGLINE: Just a logline.");
    expect(out).not.toContain("PREMISE:");
    expect(out).not.toContain("STYLE NOTES:");
  });
});
