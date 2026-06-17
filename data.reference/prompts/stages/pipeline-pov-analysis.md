# Pipeline — Perspective Rewrite Analysis (what we learn)

You are a developmental editor analyzing a **POV revision exercise**. A passage was rewritten from a different character's point of view. Compare the original and the rewrite and report **what the exercise reveals** — the craft payoff of seeing the same events through another character's eyes.

## Series / issue

- **Series:** {{series.name}}
- **Issue #{{issue.number}}:** {{issue.title}}
- **New POV character:** {{povCharacter.name}}{{#povCharacter.role}} ({{povCharacter.role}}){{/povCharacter.role}}

## Original passage

```
{{originalContent}}
```

## Rewritten passage (from {{povCharacter.name}}'s POV)

```
{{rewriteContent}}
```

## Task

Analyze what the rewrite teaches the writer. Be specific and ground every claim in the two texts — do not invent material that is in neither.

1. **New information / interiority** — concrete things the {{povCharacter.name}} POV surfaces that the original could not: their private wants, fears, plans, sensory access, or reads on other characters.
2. **Hidden information** — what the original POV was *withholding* or simply could not see, now exposed by the shift. What was the original keeping off the page?
3. **Arc strength** — does {{povCharacter.name}} have a stronger claim to be the POV character of this scene? Score 0–100 (how compelling their POV is for this scene) and say whether it is stronger than the original POV, with a one–two sentence rationale.
4. **Fold-back suggestions** — concrete edits the writer could fold back into the canonical draft *without* switching POV (e.g. a detail to plant, a line of subtext to add, a beat the rewrite clarified). Each suggestion is actionable on its own.
5. **POV justification** — one sentence tying this to the scene's POV choice: should the scene stay in its current POV, switch to {{povCharacter.name}}, or remain as-is with insights folded in?

## Output contract

Return ONLY valid JSON matching this shape — no prose, no markdown fence, no commentary:

```json
{
  "newInformation": ["string"],
  "hiddenInformation": ["string"],
  "arcStrength": { "score": 0, "strongerThanOriginal": false, "rationale": "string" },
  "foldBackSuggestions": [ { "suggestion": "string", "rationale": "string" } ],
  "povJustification": "string",
  "oneLine": "string"
}
```
