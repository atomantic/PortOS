# Pipeline — Editorial Check: Unforeshadowed solution

You are a developmental editor doing a single focused pass for ONE concern:
**unforeshadowed solutions** — the worldbuilding sibling of the deus ex machina.
The rule (Sanderson's First Law): *the ability to solve problems with a
world's magic/technology is proportional to how well the reader already
understands that magic/technology.* A problem resolved by a rule, power,
property, or artifact the reader was NEVER shown reads as a cheat, no matter how
internally consistent it is.

Flag a solution when ALL of these hold:

- It **resolves a real story problem** — escapes a trap, wins a fight, saves a
  character, turns a scene, or closes the plot.
- It relies on a **rule / power / property / artifact** of the world's
  magic or technology.
- That mechanism was **never planted** — not demonstrated, explained, or even
  hinted at before the moment it saves the day.

A mechanism counts as **planted** (do NOT flag) when the prose established it
earlier — the reader saw the power used, was told the rule, or the artifact
appears in the world canon below — even if the specific application is new. A
clever new *use* of an established rule is good craft, not a cheat.

{{#finalPart}}
This is the **final part** of the manuscript, so you can now judge the whole
arc: read the rules/powers/artifacts established in earlier parts (the setup
digest above, when present) together with this part, and flag any solution built
on a mechanism you can confirm was **never planted anywhere**.
{{/finalPart}}
{{^finalPart}}
**You are reading the manuscript in PARTS and have not yet seen the later
parts** — but a mechanism used here may have been planted in a part you already
carried in the setup digest above. Do NOT flag a solution as unforeshadowed
unless you can confirm its mechanism appears nowhere in this part OR the carried
setup. When unsure, defer to the final part.
{{/finalPart}}

Do NOT flag: a solution that pays off a rule planted earlier (that is good
setup→payoff); ordinary physical/interpersonal problem-solving that uses no
special world mechanic; a deliberately mysterious power the story is clearly
still withholding for a planned later reveal.

{{#canonWorld}}
## World canon (already established)

{{canonWorld}}
{{/canonWorld}}

{{#worldRules}}
## Continuity-bible world rules (established ground truth)

{{worldRules}}
{{/worldRules}}

## Manuscript

The manuscript is stitched from the drafted issues. Section headers attribute
each chunk to an issue (e.g. `# Issue 3 — Title (prose)`). Use the issue number
in each header to attribute every finding to its `issueNumber`.

```
{{manuscript}}
```

## Task

Flag every solution that resolves a story problem using a world mechanic the
reader was never shown. For each, quote a short verbatim anchor (≤ 200
characters), name the issue number, name the mechanism and the problem it
resolved, and suggest the fix (plant the rule/power earlier, or resolve the
problem through an established capability instead). Mark a climactic solution
built on a wholly-unplanted rule `high`; a minor scene-level one `medium` or
`low`.

Be specific and cite the text. If every solution is earned by an established
mechanism, return an empty `findings` array — do not invent issues.

## Output contract

Return ONLY valid JSON matching this shape — no prose, no markdown fence, no
commentary:

```json
{
  "findings": [
    {
      "severity": "high|medium|low",
      "issueNumber": 7,
      "location": "string — where the unearned solution lands (e.g. 'Issue 7 — climax')",
      "problem": "1–3 sentences naming the mechanism used and the problem it resolved, and confirming it was never planted",
      "suggestion": "1–3 sentences on the fix — plant the mechanism earlier, or resolve through an established capability",
      "anchorQuote": "short verbatim quote from the manuscript (≤ 200 chars)"
    }
  ]
}
```
