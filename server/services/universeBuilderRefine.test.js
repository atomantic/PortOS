import { describe, it, expect } from "vitest";
import { __testing } from "./universeBuilderRefine.js";
import { mergeInfluencesWithLocksAdditive } from "./universeBuilder.js";

const {
  extractRefinementJson,
  buildWorldRefinePrompt,
  collapseStyleDirectionDupes,
  mergeCategoriesWithLocks,
  mergeCompositesWithLocks,
} = __testing;

describe("universeBuilderRefine.extractRefinementJson", () => {
  it("parses a raw refinement object", () => {
    const obj = {
      starterPrompt: "a darker scavenger universe",
      stylePrompt: "gritty palette, deep shadows",
      negativePrompt: "cute, neon",
      rationale: "pushed mood toward grim",
    };
    expect(extractRefinementJson(JSON.stringify(obj))).toEqual(obj);
  });

  it("strips ```json fences", () => {
    const fenced =
      '```json\n{"starterPrompt":"x","stylePrompt":"y","negativePrompt":""}\n```';
    expect(extractRefinementJson(fenced)).toMatchObject({
      starterPrompt: "x",
      stylePrompt: "y",
    });
  });

  it("skips preamble before the JSON", () => {
    const raw =
      'Here is the refinement:\n{"starterPrompt":"x","stylePrompt":"y"}\nend';
    expect(extractRefinementJson(raw)).toMatchObject({ starterPrompt: "x" });
  });

  it("skips a schema-example block that has a <…> placeholder starterPrompt and parses the real block (Codex CLI prompt echo)", () => {
    const raw = [
      "codex banner",
      // The prompt template body — its first balanced { ... } block contains
      // <…> placeholders that walked past extractRefinementJson by mistake
      // would surface as "AI returned schema placeholder" instead of finding
      // the real response below it.
      '{"starterPrompt":"<full rewritten…>","stylePrompt":"<…>","negativePrompt":"<…>"}',
      "codex response:",
      '{"starterPrompt":"a darker universe","stylePrompt":"gritty","negativePrompt":""}',
    ].join("\n");
    const out = extractRefinementJson(raw);
    expect(out.starterPrompt).toBe("a darker universe");
    expect(out.stylePrompt).toBe("gritty");
  });

  it("throws when ONLY schema-placeholder blocks are present", () => {
    const raw = '{"starterPrompt":"<placeholder>","stylePrompt":"<x>"}';
    expect(() => extractRefinementJson(raw)).toThrow(/schema placeholder/);
  });

  it("throws on empty / non-string input", () => {
    expect(() => extractRefinementJson("")).toThrow(/Empty AI response/);
    expect(() => extractRefinementJson(null)).toThrow(/Empty AI response/);
  });

  it("throws when no balanced JSON object with starterPrompt is present", () => {
    expect(() => extractRefinementJson("just prose, no json")).toThrow(
      /Invalid JSON/,
    );
    expect(() => extractRefinementJson('{"prompt":"unrelated shape"}')).toThrow(
      /Invalid JSON/,
    );
  });
});

describe("universeBuilderRefine.buildWorldRefinePrompt", () => {
  it("includes originals + influences + feedback verbatim", () => {
    const out = buildWorldRefinePrompt({
      starterPrompt: "moebius scavengers",
      influences: {
        embrace: ["comic ink", "dust palette"],
        avoid: ["lowres"],
      },
      feedback: "lean grimmer and more spiritual",
    });
    expect(out).toContain("moebius scavengers");
    expect(out).toContain("comic ink, dust palette");
    expect(out).toContain("lowres");
    expect(out).toContain("lean grimmer and more spiritual");
    // Schema must mention the canonical output keys so the LLM can comply.
    expect(out).toContain('"starterPrompt"');
    expect(out).toContain('"influences"');
  });

  it("substitutes (empty) for missing originals so the LLM sees the slot", () => {
    const out = buildWorldRefinePrompt({
      starterPrompt: "seed",
      feedback: "go dark",
    });
    expect(out).toMatch(/ORIGINAL LOGLINE:\n\(empty\)/);
    expect(out).toMatch(/ORIGINAL PREMISE:\n\(empty\)/);
    expect(out).toMatch(/ORIGINAL STYLE NOTES:\n\(empty\)/);
    // Influences carry the style + negative prompt now — verify the section
    // header is present even with empty lists.
    expect(out).toMatch(/ORIGINAL INFLUENCES:/);
    // No standalone STYLE PROMPT / NEGATIVE PROMPT sections anymore.
    expect(out).not.toContain("ORIGINAL STYLE PROMPT:");
    expect(out).not.toContain("ORIGINAL NEGATIVE PROMPT:");
  });

  it("includes bible context (logline / premise / styleNotes) when provided", () => {
    const out = buildWorldRefinePrompt({
      starterPrompt: "seed",
      logline: "A foundry city goes silent.",
      premise: "Three families inherit the silence.",
      styleNotes: "Tarkovsky pacing, Moebius palette.",
      feedback: "go grimmer",
    });
    expect(out).toContain("A foundry city goes silent.");
    expect(out).toContain("Three families inherit the silence.");
    expect(out).toContain("Tarkovsky pacing, Moebius palette.");
    // Schema must declare the new output keys so the LLM emits them.
    expect(out).toContain('"logline"');
    expect(out).toContain('"premise"');
    expect(out).toContain('"styleNotes"');
  });

  it("emits a LOCKED FIELDS section when fields are pinned", () => {
    const out = buildWorldRefinePrompt({
      starterPrompt: "seed",
      logline: "L",
      premise: "",
      styleNotes: "",
      locked: { logline: true, styleNotes: true },
      feedback: "go grimmer",
    });
    expect(out).toContain("LOCKED FIELDS");
    expect(out).toContain("logline");
    expect(out).toContain("style notes");
    // The "echo unchanged" rule must appear so the LLM doesn't try to rewrite.
    expect(out).toMatch(/echo them back UNCHANGED/);
  });

  it("omits the LOCKED FIELDS section entirely when nothing is locked", () => {
    const out = buildWorldRefinePrompt({
      starterPrompt: "seed",
      feedback: "x",
    });
    expect(out).not.toContain("LOCKED FIELDS");
  });

  it("declares the structured influences schema in the output contract", () => {
    const out = buildWorldRefinePrompt({
      starterPrompt: "seed",
      feedback: "x",
    });
    // Structured influences ARE the style + negative prompt — the renderer
    // joins them verbatim so the LLM has to populate them for re-expansions
    // to inherit direction.
    expect(out).toContain('"influences"');
    expect(out).toContain('"embrace"');
    expect(out).toContain('"avoid"');
    // And the starter idea should stay a clean seed (no style-direction prose).
    expect(out).toMatch(/do NOT append style direction prose here/);
  });

  it("embeds prior influences as ORIGINAL INFLUENCES context", () => {
    const out = buildWorldRefinePrompt({
      starterPrompt: "seed",
      influences: {
        embrace: ["Moebius", "cel-shading"],
        avoid: ["Ghibli painterly"],
      },
      feedback: "lean indie comic",
    });
    expect(out).toMatch(/ORIGINAL INFLUENCES:/);
    expect(out).toContain("Embrace: Moebius, cel-shading");
    expect(out).toContain("Avoid: Ghibli painterly");
  });

  it("renders ORIGINAL INFLUENCES with (none) when lists are empty", () => {
    const out = buildWorldRefinePrompt({
      starterPrompt: "seed",
      feedback: "x",
    });
    expect(out).toMatch(/Embrace: \(none\)/);
    expect(out).toMatch(/Avoid: \(none\)/);
  });
});

describe("universeBuilderRefine.collapseStyleDirectionDupes", () => {
  it("returns input untouched when no Style direction block is present", () => {
    expect(collapseStyleDirectionDupes("a foundry city goes silent")).toBe(
      "a foundry city goes silent",
    );
  });

  it("returns input untouched when exactly one Style direction block is present", () => {
    const input =
      "A foundry city.\n\nStyle direction: Moebius palette, oil-on-canvas grain.";
    expect(collapseStyleDirectionDupes(input)).toBe(input);
  });

  it("collapses two Style direction blocks, keeping the LATEST one", () => {
    const input = [
      "A foundry city.",
      "",
      "Style direction: painterly Ghibli palette.",
      "",
      "Style direction: indie comic Moebius, cel-shading, simple palette.",
    ].join("\n");
    const out = collapseStyleDirectionDupes(input);
    expect(out).not.toContain("painterly Ghibli");
    expect(out).toContain("indie comic Moebius");
    // The seed core is preserved.
    expect(out).toContain("A foundry city.");
    // Exactly one Style direction occurrence remains.
    expect((out.match(/Style direction:/gi) || []).length).toBe(1);
  });

  it("handles arbitrary numbers of stale Style direction blocks", () => {
    const input = [
      "core",
      "Style direction: A",
      "Style direction: B",
      "Style direction: C",
    ].join("\n");
    const out = collapseStyleDirectionDupes(input);
    expect(out).toContain("Style direction: C");
    expect(out).not.toMatch(/Style direction: A/);
    expect(out).not.toMatch(/Style direction: B/);
  });

  it("is case-insensitive on the heading", () => {
    const input = "core\n\nstyle direction: lower\n\nStyle Direction: upper";
    const out = collapseStyleDirectionDupes(input);
    expect((out.match(/style direction:/gi) || []).length).toBe(1);
    expect(out).toContain("Style Direction: upper");
  });
});

describe("universeBuilderRefine.buildWorldRefinePrompt — structure-aware path", () => {
  it("emits an ORIGINAL CATEGORIES block + structure schema when categories are passed", () => {
    const out = buildWorldRefinePrompt({
      starterPrompt: "seed",
      stylePrompt: "",
      negativePrompt: "",
      categories: {
        factions: {
          variations: [
            { label: "The Velvet Null", prompt: "ink-noir cabal", locked: true },
            { label: "The Lollipop Bureau", prompt: "pastel agency" },
          ],
        },
      },
      feedback: "replace lollipop bureau",
    });
    expect(out).toContain("ORIGINAL CATEGORIES");
    expect(out).toContain('"The Velvet Null" [LOCKED]');
    expect(out).toContain('"The Lollipop Bureau"');
    expect(out).not.toMatch(/"The Lollipop Bureau" \[LOCKED\]/);
    expect(out).toContain('"categories"');
    expect(out).toContain("STRUCTURE RULES");
    expect(out).toMatch(/APPEND new tokens/);
  });

  it("emits an ORIGINAL COMPOSITE SHEETS block when sheets are passed", () => {
    const out = buildWorldRefinePrompt({
      starterPrompt: "seed",
      stylePrompt: "",
      negativePrompt: "",
      compositeSheets: [
        { kind: "world_pitch_poster", label: "Pitch poster", prompt: "city skyline", locked: true },
        { kind: "reference_sheet", label: "Uniforms sheet", prompt: "rival branding" },
      ],
      feedback: "x",
    });
    expect(out).toContain("ORIGINAL COMPOSITE SHEETS");
    expect(out).toContain('"Pitch poster" [LOCKED]');
    expect(out).toContain('"Uniforms sheet"');
    expect(out).toContain('"compositeSheets"');
  });

  it("omits structure sections entirely when no categories/composites are passed (pre-Expand)", () => {
    const out = buildWorldRefinePrompt({
      starterPrompt: "seed",
      stylePrompt: "",
      negativePrompt: "",
      feedback: "x",
    });
    expect(out).not.toContain("ORIGINAL CATEGORIES");
    expect(out).not.toContain("ORIGINAL COMPOSITE SHEETS");
    expect(out).not.toContain("STRUCTURE RULES");
    expect(out).not.toContain('"categories"');
    expect(out).not.toContain('"compositeSheets"');
  });
});

describe("universeBuilderRefine.mergeCategoriesWithLocks", () => {
  it("preserves locked variations and replaces unlocked ones from LLM output", () => {
    const original = {
      factions: {
        variations: [
          { label: "Velvet Null", prompt: "ink-noir", locked: true },
          { label: "Lollipop Bureau", prompt: "pastel agency" },
        ],
      },
    };
    const fromLlm = {
      factions: {
        variations: [
          // LLM trying to overwrite a locked label should be ignored.
          { label: "Velvet Null", prompt: "REWRITTEN BY MISTAKE" },
          // Unlocked item gets rewritten.
          { label: "Lollipop Bureau", prompt: "umbrella-academy-coded misfits in pastel" },
        ],
      },
    };
    const merged = mergeCategoriesWithLocks(original, fromLlm);
    const labels = merged.factions.variations.map((v) => v.label);
    expect(labels).toEqual(["Velvet Null", "Lollipop Bureau"]);
    const velvet = merged.factions.variations.find((v) => v.label === "Velvet Null");
    expect(velvet.prompt).toBe("ink-noir");
    expect(velvet.locked).toBe(true);
    const lollipop = merged.factions.variations.find((v) => v.label === "Lollipop Bureau");
    expect(lollipop.prompt).toBe("umbrella-academy-coded misfits in pastel");
  });

  it("appends entirely new variations the LLM proposes", () => {
    const original = {
      factions: {
        variations: [
          { label: "Velvet Null", prompt: "ink-noir", locked: true },
        ],
      },
    };
    const fromLlm = {
      factions: {
        variations: [
          { label: "Velvet Null", prompt: "x" },
          { label: "The Hollow Choir", prompt: "monastic survivors with bone instruments" },
        ],
      },
    };
    const merged = mergeCategoriesWithLocks(original, fromLlm);
    const labels = merged.factions.variations.map((v) => v.label);
    expect(labels).toContain("The Hollow Choir");
  });

  it("accepts entirely new categories the LLM proposes", () => {
    const original = { factions: { variations: [] } };
    const fromLlm = {
      factions: { variations: [] },
      secret_rituals: {
        variations: [{ label: "Solstice Mask", prompt: "midnight procession with bone masks" }],
      },
    };
    const merged = mergeCategoriesWithLocks(original, fromLlm);
    expect(merged.secret_rituals).toBeDefined();
    expect(merged.secret_rituals.variations[0].label).toBe("Solstice Mask");
  });

  it("drops unlocked items the LLM omits (effectively removed)", () => {
    const original = {
      factions: {
        variations: [
          { label: "Locked Faction", prompt: "stays", locked: true },
          { label: "Doomed Faction", prompt: "goes" },
        ],
      },
    };
    const fromLlm = {
      factions: { variations: [{ label: "Locked Faction", prompt: "ignored" }] },
    };
    const merged = mergeCategoriesWithLocks(original, fromLlm);
    const labels = merged.factions.variations.map((v) => v.label);
    expect(labels).toContain("Locked Faction");
    expect(labels).not.toContain("Doomed Faction");
  });
});

describe("universeBuilderRefine.mergeCompositesWithLocks", () => {
  it("preserves locked composites verbatim and rewrites unlocked ones", () => {
    const original = [
      { kind: "world_pitch_poster", label: "Pitch", prompt: "original pitch", locked: true },
      { kind: "reference_sheet", label: "Uniforms", prompt: "old uniforms" },
    ];
    const fromLlm = [
      { kind: "world_pitch_poster", label: "Pitch", prompt: "REWRITTEN" }, // ignored
      { kind: "reference_sheet", label: "Uniforms", prompt: "umbrella-academy uniforms" },
      { kind: "reference_sheet", label: "Vehicles", prompt: "new vehicle board" },
    ];
    const merged = mergeCompositesWithLocks(original, fromLlm);
    const labels = merged.map((c) => c.label);
    expect(labels).toEqual(["Pitch", "Uniforms", "Vehicles"]);
    expect(merged.find((c) => c.label === "Pitch").prompt).toBe("original pitch");
    expect(merged.find((c) => c.label === "Uniforms").prompt).toBe("umbrella-academy uniforms");
  });
});

describe("universeBuilder.mergeInfluencesWithLocksAdditive (refine-time)", () => {
  it("preserves locked tokens in order and APPENDS new tokens from LLM", () => {
    const merged = mergeInfluencesWithLocksAdditive(
      { influencesEmbrace: true, influencesAvoid: true },
      { embrace: ["Moebius", "Umbrella Academy"], avoid: ["kid-comic"] },
      { embrace: ["Moebius", "Brandon Graham"], avoid: ["grimdark"] },
    );
    // Original Moebius + Brandon Graham preserved in order, plus new Umbrella Academy appended.
    expect(merged.embrace).toEqual(["Moebius", "Brandon Graham", "Umbrella Academy"]);
    expect(merged.avoid).toEqual(["grimdark", "kid-comic"]);
  });

  it("does not duplicate when LLM repeats existing locked tokens", () => {
    const merged = mergeInfluencesWithLocksAdditive(
      { influencesEmbrace: true },
      { embrace: ["moebius", "MOEBIUS", "Saga"] }, // case-insensitive dedup
      { embrace: ["Moebius"] },
    );
    expect(merged.embrace).toEqual(["Moebius", "Saga"]);
  });

  it("ignores LLM removals when the list is locked", () => {
    const merged = mergeInfluencesWithLocksAdditive(
      { influencesEmbrace: true },
      { embrace: [] }, // LLM tried to wipe the list
      { embrace: ["Moebius", "Brandon Graham"] },
    );
    expect(merged.embrace).toEqual(["Moebius", "Brandon Graham"]);
  });

  it("falls through to LLM output entirely when list is NOT locked", () => {
    const merged = mergeInfluencesWithLocksAdditive(
      {}, // nothing locked
      { embrace: ["Umbrella Academy"], avoid: ["candy colored"] },
      { embrace: ["Moebius"], avoid: ["grimdark"] },
    );
    expect(merged.embrace).toEqual(["Umbrella Academy"]);
    expect(merged.avoid).toEqual(["candy colored"]);
  });
});
