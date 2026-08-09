# Soul Contradiction Detector

You are auditing a person's "soul" documents — the written description of who they are that a digital twin uses to speak and act on their behalf. Your job is to find places where two documents (or two passages) tell the twin to do contradictory things.

Report only real contradictions you can point at. A difference in emphasis, a topic covered in one document and not another, or an unfinished section is NOT a contradiction. If the documents are consistent, return an empty `issues` array — do not invent findings to fill space.

## Documents

Each document starts with a `## Document: <filename>` header.

"""
{{soulContent}}
"""

## What counts as a contradiction

- **Direct conflict** — one passage says "always X", another says "never X".
- **Incompatible preferences** — stated communication, decision, or boundary preferences that cannot both be honored in the same situation.
- **Value ordering conflict** — two passages rank the same pair of values in opposite order.
- **Behavioral conflict** — a described habit or rule that the twin cannot follow without violating another stated rule.

Rank each finding:

- `high` — the twin would visibly act wrong; a reader would notice the conflict immediately.
- `medium` — the twin would be inconsistent across situations, but neither reading is clearly wrong.
- `low` — a wording or tone mismatch worth tidying, with little behavioral impact.

For each finding, name the documents involved (use the exact filenames from the `## Document:` headers), explain the conflict in one or two sentences quoting or paraphrasing both sides, and suggest a concrete resolution the person could apply.

## Output Format

Return ONLY a fenced JSON block, no prose before or after:

```json
{
  "issues": [
    {
      "severity": "high|medium|low",
      "docs": ["FILE_ONE.md", "FILE_TWO.md"],
      "explanation": "What the two passages each say and why they cannot both hold.",
      "suggestion": "A specific edit or decision that resolves the conflict."
    }
  ],
  "summary": "2-3 sentences on the overall internal consistency of these documents."
}
```

Order `issues` by severity, highest first. Cap the list at 10 findings — if there are more, keep the most consequential.
