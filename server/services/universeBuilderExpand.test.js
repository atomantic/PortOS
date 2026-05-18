import { describe, it, expect } from "vitest";
import { __testing } from "./universeBuilderExpand.js";
import { WORLD_CATEGORIES } from "./universeBuilder.js";

const {
  extractJson,
  normalizeCategories,
  normalizeCompositeSheets,
  normalizeCanonArray,
  buildExpansionPrompt,
} = __testing;
// Anchor the legacy assertions on the static body of the prompt — the only
// dynamic substitutions are the starter idea + (optional) influences section.
const EXPANSION_PROMPT = buildExpansionPrompt({
  starterPrompt: "fixture starter",
});

describe("universeBuilderExpand.extractJson", () => {
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
    // Real-universe: Codex produced `{"label":"...","prompt":"…blister"}}]}}}`
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

  it("prefers a universe-expansion-shaped object over an in-prompt JSON example", () => {
    // The actual prompt template includes literal JSON example variations:
    //   { "label": "Crystalline canyon basin", "prompt": "…" }
    // These are valid JSON and brace-balance cleanly, but they aren't the
    // response. extractJson must skip them and return the larger object that
    // has the universe-expansion top-level keys.
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

describe("universeBuilderExpand.normalizeCategories", () => {
  it("returns all canonical categories with empty variations + kind on empty input", () => {
    const out = normalizeCategories({});
    for (const key of WORLD_CATEGORIES) {
      // schema v4 tags each bucket with a `kind` resolving its canon trunk;
      // built-in defaults carry the expected mapping from
      // WORLD_CATEGORY_DEFAULT_KINDS.
      expect(out[key]).toMatchObject({ variations: [] });
      expect(typeof out[key].kind).toBe('string');
    }
  });

  it("coerces a flat array of strings into label/prompt pairs", () => {
    const out = normalizeCategories({
      landscapes: ["Crystalline canyon basin", "Salt flat ruins"],
    });
    expect(out.landscapes.variations).toEqual([
      { id: expect.stringMatching(/^var-/), label: "Crystalline canyon basin", prompt: "Crystalline canyon basin", imageRefs: [] },
      { id: expect.stringMatching(/^var-/), label: "Salt flat ruins", prompt: "Salt flat ruins", imageRefs: [] },
    ]);
  });

  it("truncates long string-shape labels at 80 chars", () => {
    // `characters` was retired as a default bucket in schema v4 (canon owns
    // characters now). Use a different built-in bucket to probe the length
    // truncation behavior.
    const longText = "x".repeat(200);
    const out = normalizeCategories({ vehicles: [longText] });
    expect(out.vehicles.variations[0].label).toHaveLength(80);
    expect(out.vehicles.variations[0].prompt).toBe(longText);
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
      { id: expect.stringMatching(/^var-/), label: "Walker mech", prompt: "rusted six-leg walker mech", imageRefs: [] },
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
      { id: expect.stringMatching(/^var-/), label: "Tower", prompt: "spire of obsidian", imageRefs: [] },
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
      { id: expect.stringMatching(/^var-/), label: "Wake Jackals", prompt: "spare moebius scavenger raiders", imageRefs: [] },
    ]);
  });

  it("treats a non-object category as empty variations (not a crash)", () => {
    // `characters` is retired — the sanitizer drops that key entirely.
    // Probe with a custom key so the don't-crash behavior is the assertion.
    const out = normalizeCategories({ factions: "not an object" });
    expect(out.factions).toMatchObject({ variations: [] });
  });

  it("forwards LLM-returned `kind` so custom buckets land under the right trunk", () => {
    // The expansion prompt asks the LLM to tag each category with a `kind`.
    // Without explicit passthrough in the normalizer, that tag is discarded
    // and every custom bucket falls back to the default-map / `other` —
    // breaking the contract that `factions: { kind: 'characters' }` lands
    // under the characters canon trunk in the UI.
    const out = normalizeCategories({
      factions: {
        kind: "characters",
        variations: [{ label: "Wake Jackals", prompt: "scavenger raiders" }],
      },
      gear: {
        kind: "objects",
        variations: [{ label: "Bone hook", prompt: "carved bone hook" }],
      },
    });
    expect(out.factions.kind).toBe("characters");
    expect(out.gear.kind).toBe("objects");
  });
});

describe("universeBuilderExpand.normalizeCompositeSheets", () => {
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
        id: expect.stringMatching(/^sheet-/),
        kind: "reference_sheet",
        label: "Gas-Giant Drifters costume sheet",
        prompt:
          "Create a clean illustrated costume reference sheet with five figures, material swatches, fasteners, accessories, color palette strip, and simple floating-platform background.",
        imageRefs: [],
      },
    ]);
  });

  it("coerces string sheets into label/prompt pairs", () => {
    const out = normalizeCompositeSheets(["Canopy Symbiotes reference board"]);
    expect(out).toEqual([
      {
        id: expect.stringMatching(/^sheet-/),
        kind: "reference_sheet",
        label: "Canopy Symbiotes reference board",
        prompt: "Canopy Symbiotes reference board",
        imageRefs: [],
      },
    ]);
  });

  it("preserves universe pitch poster board kind", () => {
    const out = normalizeCompositeSheets([
      {
        kind: "world_pitch_poster",
        label: "Universe summary concept pitch poster",
        prompt:
          "Create a cinematic universe summary concept pitch poster with hero panorama, inset environments, culture callouts, palette, materials, light atmosphere, and theme icons.",
      },
    ]);
    expect(out).toEqual([
      {
        id: expect.stringMatching(/^sheet-/),
        kind: "world_pitch_poster",
        label: "Universe summary concept pitch poster",
        prompt:
          "Create a cinematic universe summary concept pitch poster with hero panorama, inset environments, culture callouts, palette, materials, light atmosphere, and theme icons.",
        imageRefs: [],
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

describe("universeBuilderExpand.normalizeCanonArray", () => {
  it("returns [] for non-array input", () => {
    expect(normalizeCanonArray(null, "character")).toEqual([]);
    expect(normalizeCanonArray(undefined, "character")).toEqual([]);
    expect(normalizeCanonArray("not an array", "character")).toEqual([]);
    expect(normalizeCanonArray({}, "character")).toEqual([]);
  });

  it("sanitizes a character entry to the bible shape (id, timestamps, physicalDescription)", () => {
    const out = normalizeCanonArray(
      [{ name: "Ash", physicalDescription: "young survivor with iron rebar" }],
      "character",
    );
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("Ash");
    expect(out[0].physicalDescription).toBe("young survivor with iron rebar");
    expect(out[0].id).toBeTruthy();
    expect(out[0].createdAt).toBeTruthy();
  });

  it("sanitizes a setting entry, requiring at least one identifier (name OR slugline)", () => {
    const out = normalizeCanonArray(
      [
        { name: "Foundry City", description: "vast iron metropolis", palette: "rust + brass" },
        { slugline: "INT. FOUNDRY CITY — DAY" },
        { description: "no name no slugline — dropped" },
      ],
      "place",
    );
    expect(out).toHaveLength(2);
    expect(out[0].name).toBe("Foundry City");
    expect(out[0].palette).toBe("rust + brass");
    expect(out[1].slugline).toBe("INT. FOUNDRY CITY — DAY");
  });

  it("sanitizes an object entry, requiring a name", () => {
    const out = normalizeCanonArray(
      [
        { name: "The Tongue", description: "an artifact that absorbs language", significance: "central MacGuffin" },
        { description: "nameless — dropped" },
      ],
      "object",
    );
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("The Tongue");
    expect(out[0].significance).toBe("central MacGuffin");
  });
});

describe("universeBuilderExpand.EXPANSION_PROMPT", () => {
  it("allows dynamic universe-building buckets and reference-sheet domains", () => {
    expect(EXPANSION_PROMPT).toContain("Add, remove, or rename buckets");
    expect(EXPANSION_PROMPT).toContain("colonies, factions, tribes, species");
    expect(EXPANSION_PROMPT).toContain("clothing guides");
    expect(EXPANSION_PROMPT).toContain("raider_clans");
    expect(EXPANSION_PROMPT).toContain("compositeSheets");
    expect(EXPANSION_PROMPT).toContain("world_pitch_poster");
    expect(EXPANSION_PROMPT).toContain("universe summary concept pitch poster");
    expect(EXPANSION_PROMPT).toContain("materials swatches");
  });

  it("asks the LLM to emit a narrative bible (logline / premise / styleNotes)", () => {
    // The pipeline pulls these straight into the New Series form, so the
    // contract has to stay in the prompt. If this assertion fails, double-
    // check that universeBuilderExpand.js still hydrates the three fields too.
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

  it("asks the LLM to emit canon arrays (characters / places / objects) with rich metadata", () => {
    // Phase B contract: canon arrays are first-class outputs of the expand
    // call. The client merges them into universe.characters[]/.places[]/.objects[]
    // and the redesigned UI surfaces them under their canon trunks. If this
    // assertion fails, also verify normalizeCanonArray + expandWorldTemplate
    // still surface the returned values in the response payload.
    expect(EXPANSION_PROMPT).toContain("characters:");
    expect(EXPANSION_PROMPT).toContain("physicalDescription");
    expect(EXPANSION_PROMPT).toContain("places:");
    expect(EXPANSION_PROMPT).toContain("slugline");
    expect(EXPANSION_PROMPT).toContain("recurringDetails");
    expect(EXPANSION_PROMPT).toContain("objects:");
    expect(EXPANSION_PROMPT).toContain("significance");
  });

  it("teaches the LLM to tag each category with a `kind` so it lands under the right canon trunk", () => {
    // Without this, post-Phase-A UIs that group categories by kind put every
    // new bucket under 'other' until the user hand-sorts.
    expect(EXPANSION_PROMPT).toContain('"kind"');
    expect(EXPANSION_PROMPT).toContain('"characters"');
    expect(EXPANSION_PROMPT).toContain('"places"');
    expect(EXPANSION_PROMPT).toContain('"objects"');
    expect(EXPANSION_PROMPT).toContain('"other"');
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

  it("omits the Current universe state section when no bible/prompt fields are provided", () => {
    const out = buildExpansionPrompt({ starterPrompt: "seed" });
    expect(out).not.toContain("# Current universe state");
  });

  it("includes provided bible fields as Current universe state context", () => {
    const out = buildExpansionPrompt({
      starterPrompt: "seed",
      priorLogline: "A foundry city goes silent.",
      priorPremise: "Three families inherit the silence.",
      priorStyleNotes: "Tarkovsky pacing, Moebius palette.",
    });
    expect(out).toContain("# Current universe state");
    expect(out).toContain("LOGLINE: A foundry city goes silent.");
    expect(out).toContain("PREMISE: Three families inherit the silence.");
    expect(out).toContain("STYLE NOTES: Tarkovsky pacing, Moebius palette.");
    // Style + negative prompts are no longer separate scalars — they live in
    // the influences section instead.
    expect(out).not.toContain("STYLE PROMPT:");
    expect(out).not.toContain("NEGATIVE PROMPT:");
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

  it("skips empty bible/prompt fields from Current universe state", () => {
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
