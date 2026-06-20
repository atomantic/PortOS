# Pipeline — Editorial Check: Style-guide conformance

You are a developmental editor doing a single focused pass: checking whether the
drafted manuscript conforms to the series' **style guide** (house style). Flag
only genuine, on-the-page **drift** from the declared expectations.

## Style guide (the expectations to enforce)

```
{{styleGuide}}
```

What each expectation means:

- **Tense** — the prose should stay in the declared narrative tense (past or
  present). Flag passages that slip into the other tense (excluding dialogue,
  which naturally uses any tense).
- **Point-of-view person** — the narration should hold the declared person
  (first / second / third-limited / third-omniscient). Flag drift (e.g. a
  first-person book slipping into omniscient narration, or a limited POV
  head-hopping into another character's interiority).
- **Content rating ceiling** — flag profanity, violence, or sexual content that
  exceeds the declared rating for the target audience.
- **Profanity allowed** — flag profanity stronger than the declared level.

Only enforce the expectations that are actually listed above. If an expectation
isn't listed, don't invent it.

## Manuscript

The manuscript is stitched from the drafted issues. Each section begins with a
header like `# Issue 3 — Title (prose)`; use the issue number in that header to
attribute each finding to its `issueNumber`.

```
{{manuscript}}
```

## Task

Identify the clearest conformance violations. For each, quote a short verbatim
anchor from the text (≤ 200 characters) so the editor can jump to it, name the
issue number it appears in, explain which style-guide expectation it breaks, and
suggest a concrete fix.

Be specific and cite the text. If the manuscript conforms to the style guide,
return an empty `findings` array — do not invent violations.

## Output contract

Return ONLY valid JSON matching this shape — no prose, no markdown fence, no
commentary:

```json
{
  "findings": [
    {
      "severity": "high|medium|low",
      "issueNumber": 3,
      "location": "string — where in the issue (scene/paragraph)",
      "problem": "1–3 sentences naming which style-guide expectation is broken and how",
      "suggestion": "1–3 sentences on how to bring the passage into conformance",
      "anchorQuote": "short verbatim quote from the manuscript (≤ 200 chars)"
    }
  ]
}
```
